import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { v4 as uuidv4 } from 'uuid';
import { PresignUploadDto, UploadType } from './dto';

export interface SignedDownloadUrl {
  url: string;
  expiresIn: number;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  key: string;
  expiresIn: number;
}

export interface ObjectHead {
  size: number;
  contentType?: string;
}

@Injectable()
export class UploadService {
  private s3Client: S3Client;
  private bucketName: string;

  // File size limits (in bytes)
  // The most that may enter the bucket: 180s of video at 3.63Mbps plus VBR headroom.
  readonly MAX_VIDEO_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB
  // Clients compress before uploading, so anything larger is a client that did not.
  readonly MAX_IMAGE_UPLOAD_SIZE = 1 * 1024 * 1024; // 1MB

  // Signed URL expiration times
  private readonly UPLOAD_URL_EXPIRATION = 3600; // 1 hour
  private readonly DOWNLOAD_URL_EXPIRATION = 86400; // 24 hours

  // Keys carry a uuid, so objects are immutable and safe to cache for a year.
  private readonly IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

  private static mb(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  }

  constructor(private configService: ConfigService) {
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
    const bucketName = this.configService.get<string>('AWS_S3_BUCKET');
    const region = this.configService.get<string>('AWS_REGION') || 'us-east-1';

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials are not configured');
    }

    if (!bucketName) {
      throw new Error('AWS_S3_BUCKET is not configured');
    }

    console.log('S3 Configuration:', {
      region,
      bucket: bucketName,
      accessKeyId: accessKeyId?.substring(0, 8) + '...',
      secretKeyLength: secretAccessKey?.length,
    });

    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.bucketName = bucketName;
  }


  /**
   * Generate a signed URL for downloading a file from S3
   */
  async generateDownloadUrl(key: string): Promise<SignedDownloadUrl> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    const url = await getSignedUrl(this.s3Client, command, {
      expiresIn: this.DOWNLOAD_URL_EXPIRATION,
    });

    return {
      url,
      expiresIn: this.DOWNLOAD_URL_EXPIRATION,
    };
  }

  /**
   * Delete a file from S3
   */
  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    await this.s3Client.send(command);
  }
  /** Presigned POST for a direct device -> S3 upload; PUT is unusable because it cannot bound body size. */
  async generatePresignedPost(
    userId: string,
    dto: PresignUploadDto,
  ): Promise<PresignedUpload> {
    // Images keep the proxy path — they are <1MB after client compression and do server-side work.
    if (dto.type !== UploadType.VIDEO) {
      throw new BadRequestException('Only video uploads use presigned upload');
    }

    if (!dto.contentType.startsWith('video/')) {
      throw new BadRequestException('Only video content types allowed');
    }

    if (dto.fileSize > this.MAX_VIDEO_UPLOAD_SIZE) {
      console.warn(
        `[presign] DENIED user=${userId} ${UploadService.mb(dto.fileSize)} exceeds ` +
          `${UploadService.mb(this.MAX_VIDEO_UPLOAD_SIZE)}`,
      );
      throw new BadRequestException(
        `Video file too large. Maximum size: ${this.MAX_VIDEO_UPLOAD_SIZE / 1024 / 1024}MB`,
      );
    }

    const key = this.generateS3Key(userId, dto.type, dto.fileName);

    const { url, fields } = await createPresignedPost(this.s3Client, {
      Bucket: this.bucketName,
      Key: key,
      Expires: this.UPLOAD_URL_EXPIRATION,
      Fields: {
        'Content-Type': dto.contentType,
        'Cache-Control': this.IMMUTABLE_CACHE_CONTROL,
      },
      // S3 itself rejects an oversized body with 400 EntityTooLarge — the only authoritative gate.
      Conditions: [
        ['content-length-range', 1, this.MAX_VIDEO_UPLOAD_SIZE],
        ['eq', '$Content-Type', dto.contentType],
      ],
    });

    console.log(
      `[presign] GRANTED user=${userId} key=${key} declared=${UploadService.mb(dto.fileSize)} ` +
        `ceiling=${UploadService.mb(this.MAX_VIDEO_UPLOAD_SIZE)} expires=${this.UPLOAD_URL_EXPIRATION}s`,
    );

    return { url, fields, key, expiresIn: this.UPLOAD_URL_EXPIRATION };
  }

  /** Object metadata, or null when the key does not exist. */
  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      const size = res.ContentLength ?? 0;
      console.log(`[head] ${key} -> ${UploadService.mb(size)} ${res.ContentType ?? ''}`);
      return { size, contentType: res.ContentType };
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if (status === 404 || status === 403 || error?.name === 'NotFound') {
        console.warn(`[head] ${key} -> MISSING (${status})`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Generate S3 key based on upload type
   */
  private generateS3Key(userId: string, type: UploadType, fileName: string): string {
    const timestamp = Date.now();
    const randomId = uuidv4();
    const extension = this.getFileExtension(fileName);

    switch (type) {
      case UploadType.VIDEO:
        return `videos/${userId}/${timestamp}-${randomId}.${extension}`;
      case UploadType.THUMBNAIL:
        return `thumbnails/${userId}/${timestamp}-${randomId}.${extension}`;
      case UploadType.PROFILE_IMAGE:
        return `profiles/${userId}/${timestamp}-${randomId}.${extension}`;
      case UploadType.CHAT_IMAGE:
        return `chat/${userId}/${timestamp}-${randomId}.${extension}`;
      default:
        return `uploads/${userId}/${timestamp}-${randomId}.${extension}`;
    }
  }

  /**
   * Extract file extension from filename
   */
  private getFileExtension(fileName: string): string {
    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : 'bin';
  }

  /**
   * Validate file size based on upload type
   */
  private validateFileSize(type: UploadType, fileSize: number): void {
    switch (type) {
      case UploadType.VIDEO:
        if (fileSize > this.MAX_VIDEO_UPLOAD_SIZE) {
          throw new BadRequestException(
            `Video file too large. Maximum size: ${this.MAX_VIDEO_UPLOAD_SIZE / 1024 / 1024}MB`,
          );
        }
        break;

      case UploadType.THUMBNAIL:
      case UploadType.PROFILE_IMAGE:
      case UploadType.CHAT_IMAGE:
        if (fileSize > this.MAX_IMAGE_UPLOAD_SIZE) {
          throw new BadRequestException(
            `Image file too large. Maximum size: ${this.MAX_IMAGE_UPLOAD_SIZE / 1024 / 1024}MB`,
          );
        }
        break;

      default:
        throw new BadRequestException('Invalid upload type');
    }
  }

 
  getPublicUrl(key: string): string {
    const region = this.configService.get<string>('AWS_REGION') || 'us-east-1';
    return `https://${this.bucketName}.s3.${region}.amazonaws.com/${key}`;
  }

  /** Proxy an image to S3; images are small enough after client compression that this costs nothing. */
  async uploadFile(
    userId: string,
    type: UploadType,
    file: Express.Multer.File,
  ): Promise<{ key: string; url: string }> {
    this.validateFileSize(type, file.size);

    const key = this.generateS3Key(userId, type, file.originalname);

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentLength: file.size,
      ContentType: file.mimetype,
      CacheControl: this.IMMUTABLE_CACHE_CONTROL,
      Metadata: {
        userId,
        originalFileName: file.originalname,
        uploadType: type,
      },
    });

    try {
      await this.s3Client.send(command);
      console.log(`[upload] OK type=${type} key=${key} ${UploadService.mb(file.size)}`);

      // Never presigned: these land in DB rows served to every viewer and would expire.
      return { key, url: this.getPublicUrl(key) };
    } catch (error) {
      console.error('S3 Upload Error:', {
        message: error.message,
        code: error.Code || error.code,
        bucket: this.bucketName,
        key,
      });
      throw new BadRequestException(
        `Failed to upload file to S3: ${error.message}`,
      );
    }
  }
}

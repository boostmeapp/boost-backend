import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { UploadType } from './dto';

export interface SignedUploadUrl {
  uploadId: string;
  uploadUrl: string;
  key: string;
  expiresIn: number;
}

export interface SignedDownloadUrl {
  url: string;
  expiresIn: number;
}

@Injectable()
export class UploadService {
  private s3Client: S3Client;
  private bucketName: string;

  // File size limits (in bytes)
  private readonly MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB
  private readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

  // Signed URL expiration times
  private readonly UPLOAD_URL_EXPIRATION = 3600; // 1 hour
  private readonly DOWNLOAD_URL_EXPIRATION = 86400; // 24 hours

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
        if (fileSize > this.MAX_VIDEO_SIZE) {
          throw new BadRequestException(
            `Video file too large. Maximum size: ${this.MAX_VIDEO_SIZE / 1024 / 1024}MB`,
          );
        }
        break;

      case UploadType.THUMBNAIL:
      case UploadType.PROFILE_IMAGE:
        if (fileSize > this.MAX_IMAGE_SIZE) {
          throw new BadRequestException(
            `Image file too large. Maximum size: ${this.MAX_IMAGE_SIZE / 1024 / 1024}MB`,
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

  /**
   * Upload a file directly to S3 (server-side upload)
   * Returns the S3 key of the uploaded file
   */
  async uploadFile(
    userId: string,
    type: UploadType,
    file: Express.Multer.File,
  ): Promise<{ key: string; url: string }> {
    // Validate file size
    this.validateFileSize(type, file.size);

    // Generate unique key
    const key = this.generateS3Key(userId, type, file.originalname);

    // Create PutObject command
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        userId,
        originalFileName: file.originalname,
        uploadType: type,
      },
    });

    try {
      // Upload to S3
      await this.s3Client.send(command);

      return {
        key,
        url: this.getPublicUrl(key),
      };
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

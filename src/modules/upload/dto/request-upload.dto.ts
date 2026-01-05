import { IsString, IsNotEmpty, IsNumber, IsPositive, IsEnum, IsOptional, MaxLength } from 'class-validator';

export enum UploadType {
  VIDEO = 'video',
  THUMBNAIL = 'thumbnail',
  PROFILE_IMAGE = 'profile_image',
}

export class RequestUploadDto {
  @IsEnum(UploadType)
  type: UploadType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string; // Original filename

  @IsString()
  @IsNotEmpty()
  contentType: string; // MIME type (e.g., video/mp4, image/jpeg)

  @IsNumber()
  @IsPositive()
  fileSize: number; // File size in bytes

  @IsNumber()
  @IsPositive()
  @IsOptional()
  duration?: number; // Video duration in seconds (for videos only)
}

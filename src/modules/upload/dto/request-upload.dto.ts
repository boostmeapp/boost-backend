import { Type } from 'class-transformer';
import { IsString, IsNotEmpty, IsNumber, IsPositive, IsEnum, IsOptional, Min, MaxLength } from 'class-validator';

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
  @MaxLength(255)
  contentType: string; // MIME type (e.g., video/mp4, image/jpeg)

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  fileSize: number; // File size in bytes

  // Matches CreateVideoDto: 0 means "unknown", not invalid.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  duration?: number; // Video duration in seconds (for videos only)
}

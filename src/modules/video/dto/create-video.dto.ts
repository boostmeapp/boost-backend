import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsArray,
  Min,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

// S3 object keys are capped at 1024 bytes; URLs get a little more headroom.
const MAX_KEY_LENGTH = 1024;
const MAX_URL_LENGTH = 2048;

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  caption?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  tags?: string[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_KEY_LENGTH)
  rawVideoKey: string; // S3 key of uploaded video

  @IsString()
  @IsOptional()
  @MaxLength(MAX_URL_LENGTH)
  thumbnailUrl?: string; // Absolute, public cover-image URL. Empty when none exists.

  @IsString()
  @IsOptional()
  @MaxLength(MAX_KEY_LENGTH)
  thumbnailKey?: string; // S3 key of the cover image

  // Clients send this as a string, and 0 means "unknown" rather than invalid.
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  duration: number; // Duration in seconds
}

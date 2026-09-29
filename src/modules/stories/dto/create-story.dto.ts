import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { StoryMediaType } from '../../../database/schemas/story/story.schema';
import { MAX_STORY_VIDEO_SECONDS } from '../stories.constants';

// S3 object keys are capped at 1024 bytes.
const MAX_KEY_LENGTH = 1024;

/**
 * The client uploads to S3 first (POST /upload/presign for a clip, the image
 * endpoints for a photo) and posts the resulting key here.
 */
export class CreateStoryDto {
  @IsEnum(StoryMediaType)
  mediaType: StoryMediaType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_KEY_LENGTH)
  mediaKey: string;

  /** Poster frame for a video story. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_KEY_LENGTH)
  thumbnailKey?: string;

  /** Required for a video, and never more than 30 seconds. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_STORY_VIDEO_SECONDS)
  durationSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  music?: string;
}

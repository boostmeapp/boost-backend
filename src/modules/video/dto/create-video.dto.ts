import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsPositive,
  IsArray,
  MaxLength,
} from 'class-validator';

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

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsNotEmpty()
  rawVideoKey: string; // S3 key of uploaded video

  @IsString()
  @IsNotEmpty()
  thumbnailUrl: string; // S3 key of thumbnail

  @IsNumber()
  @IsPositive()
  duration: number; // Duration in seconds
}

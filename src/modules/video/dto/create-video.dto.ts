import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsPositive,
  IsArray,
  MaxLength,
  ArrayMaxSize,
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

@IsOptional()
@IsArray()
@ArrayMaxSize(10)
@IsString({ each: true })
@MaxLength(30, { each: true })
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

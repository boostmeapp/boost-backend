import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { UploadType } from './upload-type.enum';

// Every field must be declared: main.ts runs forbidNonWhitelisted, so an undeclared one is a 400.
export class PresignUploadDto {
  @IsEnum(UploadType)
  type: UploadType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  contentType: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  fileSize: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  duration?: number;
}

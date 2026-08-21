import {
  IsOptional,
  IsString,
  IsDateString,
  MaxLength,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  gender?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsString()
  @MaxLength(900)
  bio?: string;

  // Holds a full public S3 URL since the upload service stopped presigning images.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  profileImage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  username?: string;
}

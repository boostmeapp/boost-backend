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

  @IsOptional()
  @IsString()
  profileImage?: string;

    @IsOptional()
  @IsString()
  username?: string;

}

import { IsString, MinLength } from 'class-validator';

export class VerifyPasswordDto {
  @IsString()
  @MinLength(1)
  password: string;
}

import { IsString, Length, MinLength } from 'class-validator';

export class ConfirmAccountDeleteDto {
  @IsString()
  @Length(4, 8)
  otp: string;

  @IsString()
  @MinLength(1)
  password: string;
}

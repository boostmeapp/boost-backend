import { IsEmail, IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(4, 8)
  otp: string;
}

import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  // Either otp or token must be supplied.
  @ValidateIf((o) => !o.token)
  @IsString()
  @Length(4, 8)
  otp?: string;

  @ValidateIf((o) => !o.otp)
  @IsString()
  token?: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

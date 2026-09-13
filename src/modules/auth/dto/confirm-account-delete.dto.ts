import { IsOptional, IsString, Length, MinLength } from 'class-validator';

export class ConfirmAccountDeleteDto {
  @IsString()
  @Length(4, 8)
  otp: string;

  // Optional: the app verifies the password on the preceding screen, and this
  // endpoint already requires a valid session plus an emailed one-time code.
  // Still checked when a client does send it.
  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;
}

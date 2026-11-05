import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AppleLoginDto {
  /** The identity token returned by Sign in with Apple on the device. */
  @IsString()
  @MinLength(20)
  identityToken: string;

  /** The raw nonce; Apple was given its SHA-256. */
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  nonce: string;

  /** Single-use, 5-minute code; exchanged for a refresh token to revoke on deletion. */
  @IsOptional()
  @IsString()
  authorizationCode?: string;

  /** Apple sends the name only on the first authorization, and unsigned. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  lastName?: string;
}

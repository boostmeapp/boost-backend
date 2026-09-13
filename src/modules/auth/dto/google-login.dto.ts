import { IsString, MinLength } from 'class-validator';

export class GoogleLoginDto {
  /** The ID token returned by Google Sign-In on the device. */
  @IsString()
  @MinLength(20)
  idToken: string;
}

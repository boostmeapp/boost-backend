import { IsEmail, IsString, MinLength } from 'class-validator';

// TEST ONLY: payload for POST /auth/test/delete-account.
export class TestDeleteAccountDto {
  @IsString()
  @MinLength(1)
  key: string;

  @IsEmail()
  email: string;
}

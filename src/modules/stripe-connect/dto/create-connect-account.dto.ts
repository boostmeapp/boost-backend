import { IsEmail, IsNotEmpty } from 'class-validator';

export class CreateConnectAccountDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

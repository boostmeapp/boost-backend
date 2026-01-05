import { IsString, IsNotEmpty } from 'class-validator';

export class ConfirmTopUpDto {
  @IsString()
  @IsNotEmpty()
  paymentIntentId: string;
}

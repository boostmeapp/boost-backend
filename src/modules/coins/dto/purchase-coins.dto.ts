import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class PurchaseCoinsDto {
  @IsString()
  @IsNotEmpty()
  packageKey: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';

  // iOS: base64 receipt data. Android: purchase token.
  @IsString()
  @IsNotEmpty()
  receipt: string;
}

import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class PurchaseBoostDto {
  @IsString()
  @IsNotEmpty()
  productKey: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';

  @IsString()
  @IsNotEmpty()
  videoId: string;

  // iOS: base64 receipt data. Android: purchase token.
  @IsString()
  @IsNotEmpty()
  receipt: string;
}

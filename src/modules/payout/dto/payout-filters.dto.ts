import { IsOptional, IsEnum, IsString } from 'class-validator';
import { PayoutStatus } from '../../../database/schemas/payout/payout.schema';

export class PayoutFiltersDto {
  @IsOptional()
  @IsEnum(PayoutStatus)
  status?: PayoutStatus;

  @IsOptional()
  @IsString()
  batchId?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}

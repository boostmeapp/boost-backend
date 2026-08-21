import { Type } from 'class-transformer';
import { IsString, IsNotEmpty, IsNumber, Min, Max, MaxLength } from 'class-validator';
import { REWARD_CONFIG } from '../../../database/schemas/boost/boost.schema';

export class CreateBoostDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  videoId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(REWARD_CONFIG.MIN_BOOST_AMOUNT)
  @Max(REWARD_CONFIG.MAX_BOOST_AMOUNT)
  amount: number; // Amount in euros (€1 - €100)
}

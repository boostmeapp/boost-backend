import { Type } from 'class-transformer';
import { IsNumber, Min, Max } from 'class-validator';

export class CreateTopUpIntentDto {
  // @Min(1) already implies positive, so @IsPositive was redundant.
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1000)
  amount: number; // Amount in euros (€)
}

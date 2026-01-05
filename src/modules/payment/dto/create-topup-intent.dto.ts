import { IsNumber, IsPositive, Min, Max } from 'class-validator';

export class CreateTopUpIntentDto {
  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(1000)
  amount: number; // Amount in euros (€)
}

import { IsString, IsNotEmpty, IsNumber, Min, Max } from 'class-validator';

export class PromoteDto {
  @IsString()
  @IsNotEmpty()
  videoId: string;

  @IsNumber()
  @Min(3)
  @Max(1000)
  budgetPerDay: number;

  @IsNumber()
  @Min(1)
  @Max(30)
  durationDays: number;
}

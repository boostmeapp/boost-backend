import { Type } from 'class-transformer';
import { IsString, IsNotEmpty, IsNumber, IsInt, Min, Max, MaxLength } from 'class-validator';

export class PromoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  videoId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(3)
  @Max(1000)
  budgetPerDay: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  durationDays: number;
}

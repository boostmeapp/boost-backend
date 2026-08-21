import { Type } from 'class-transformer';
import { IsString, IsNotEmpty, IsNumber, IsPositive, MaxLength } from 'class-validator';

export class RecordWatchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  videoId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  watchDuration: number; // Duration watched in seconds
}

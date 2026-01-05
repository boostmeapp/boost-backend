import { IsString, IsNotEmpty, IsNumber, IsPositive } from 'class-validator';

export class RecordWatchDto {
  @IsString()
  @IsNotEmpty()
  videoId: string;

  @IsNumber()
  @IsPositive()
  watchDuration: number; // Duration watched in seconds
}

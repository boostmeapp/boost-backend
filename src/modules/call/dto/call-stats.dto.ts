import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Client-reported quality at call end. Untrusted: every field is bounded, and
 * anything out of range is rejected (400), never stored raw.
 */
export class CallStatsDto {
  /** Mean opinion score, 1 (bad) to 5 (excellent). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(5)
  mos?: number;

  /** Percent of packets lost, 0–100. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  packetLoss?: number;

  /** Jitter in milliseconds. */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(10_000)
  jitter?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000)
  reconnectCount?: number;
}

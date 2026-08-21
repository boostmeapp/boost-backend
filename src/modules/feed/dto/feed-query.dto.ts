import { IsOptional, IsString, IsInt, Min, Max, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class FeedQueryDto {
  /** Legacy offset pagination. Ignored when `cursor` is present. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  // 20 matches what the app sends; 50 caps a cheap amplification vector.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  /** Opaque keyset cursor from a previous response's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  cursor?: string;
}

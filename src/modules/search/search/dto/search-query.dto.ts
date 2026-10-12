import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const SEARCH_TYPES = ['all', 'users', 'videos'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export class SearchQueryDto {
  /**
   * Capped: the term goes into a regular expression, and an unbounded one is
   * both a pointless scan and a denial-of-service shape.
   */
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : ''))
  q: string;

  @IsOptional()
  @IsIn(SEARCH_TYPES)
  type?: SearchType = 'all';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

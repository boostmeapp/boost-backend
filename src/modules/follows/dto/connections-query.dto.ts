import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Paging for the connections lists. The app loads ten rows and asks for the
 * next ten as you scroll, so the default matches that page size.
 */
export class ConnectionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;

  /** Search box on the followers screen; matches username and first/last name. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;
}

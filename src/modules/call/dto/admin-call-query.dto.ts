import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CallStatus } from '../call.constants';

export class AdminCallQueryDto extends PaginationDto {
  /** Calls this user took part in, either side. */
  @IsOptional()
  @IsMongoId()
  userId?: string;

  @IsOptional()
  @IsEnum(CallStatus)
  status?: CallStatus;

  /** createdAt lower bound, ISO 8601. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** createdAt upper bound, ISO 8601. */
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class CallMetricsQueryDto {
  /** Look-back window in hours. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 30)
  hours?: number = 24;
}

export class SetCallingRestrictedDto {
  @IsBoolean()
  restricted: boolean;
}

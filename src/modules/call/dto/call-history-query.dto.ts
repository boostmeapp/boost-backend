import { IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { CallStatus } from '../call.constants';

export class CallHistoryQueryDto extends PaginationDto {
  /** Only calls started from this chat thread. */
  @IsOptional()
  @IsMongoId()
  conversationId?: string;

  /** e.g. `active`, for the app's crash-rejoin check on start. */
  @IsOptional()
  @IsEnum(CallStatus)
  status?: CallStatus;
}

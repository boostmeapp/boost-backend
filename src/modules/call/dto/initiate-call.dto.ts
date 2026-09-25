import { IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { CallType } from '../call.constants';

export class InitiateCallDto {
  @IsMongoId()
  calleeId: string;

  @IsEnum(CallType)
  callType: CallType;

  /** The chat thread the call was started from; omitted when started from a profile. */
  @IsOptional()
  @IsMongoId()
  conversationId?: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApnsEnvironment } from '../call.constants';

export class CallPushTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  token: string;

  @IsIn(['firebase', 'apn'])
  provider: 'firebase' | 'apn';

  /** iOS PushKit token (CallKit ringing). */
  @IsOptional()
  @IsBoolean()
  voip?: boolean;
}

export class ClaimCallingDeviceDto {
  /** Picks the APNs provider for an iOS VoIP token; same meaning as on /calls/token. */
  @IsOptional()
  @IsEnum(ApnsEnvironment)
  apnsEnvironment?: ApnsEnvironment;

  /**
   * This install's push tokens. They stay registered on Stream; every other
   * device of the user is removed, so only this one rings. Empty is allowed
   * (e.g. notifications denied): the claim still moves calling here.
   */
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => CallPushTokenDto)
  pushTokens: CallPushTokenDto[];
}

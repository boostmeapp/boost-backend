import { IsEnum } from 'class-validator';
import { CallPrivacy } from '../call.constants';

export class UpdateCallSettingsDto {
  /** Who can call me: everyone | mutual_follows | nobody. */
  @IsEnum(CallPrivacy)
  callPrivacy: CallPrivacy;
}

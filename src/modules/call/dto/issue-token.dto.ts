import { IsEnum, IsOptional } from 'class-validator';
import { ApnsEnvironment } from '../call.constants';

export class IssueTokenDto {
  /**
   * The APNs environment of the requesting app build. iOS builds must send it:
   * a mismatch drops every VoIP push silently. Defaults to production, which
   * is right for every store and TestFlight build.
   */
  @IsOptional()
  @IsEnum(ApnsEnvironment)
  apnsEnvironment?: ApnsEnvironment;
}

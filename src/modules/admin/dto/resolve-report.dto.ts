import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum ResolveAction {
  REMOVE_CONTENT = 'remove_content',
  BAN_USER = 'ban_user',
  DISMISS = 'dismiss',
}

export class ResolveReportDto {
  @IsEnum(ResolveAction)
  action: ResolveAction;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

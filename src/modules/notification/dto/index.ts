import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import { DevicePlatform } from '../notification.constants';

export class RegisterDeviceTokenDto {
  @IsString()
  @MaxLength(4096)
  token: string;

  @IsOptional()
  @IsEnum(DevicePlatform)
  platform?: DevicePlatform;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}

export class RemoveDeviceTokenDto {
  @IsString()
  @MaxLength(4096)
  token: string;
}

export class ListNotificationsDto {
  @IsOptional()
  @IsIn(['all', 'unread', 'boosts'])
  filter?: 'all' | 'unread' | 'boosts';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class SendTestNotificationDto {
  @IsString()
  @MaxLength(4096)
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  body?: string;
}

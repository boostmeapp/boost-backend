import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  AudienceSize,
  CampaignGoal,
  TargetAge,
  TargetGender,
} from '../../../database/schemas/boost-campaign/boost-campaign.schema';
import { BOOST_CONFIG } from '../boost-campaigns.config';

export class TargetingDto {
  @IsEnum(AudienceSize)
  audienceSize: AudienceSize;

  @IsEnum(TargetAge)
  age: TargetAge;

  @IsEnum(TargetGender)
  gender: TargetGender;
}

export class EstimateCampaignDto {
  @ValidateNested()
  @Type(() => TargetingDto)
  targeting: TargetingDto;

  @Type(() => Number)
  @IsInt()
  @Min(BOOST_CONFIG.COINS_MIN)
  @Max(BOOST_CONFIG.COINS_MAX)
  coins: number;

  @Type(() => Number)
  @IsIn(BOOST_CONFIG.DURATIONS)
  durationDays: number;
}

export class CreateCampaignDto extends EstimateCampaignDto {
  @IsMongoId()
  videoId: string;

  @IsOptional()
  @IsEnum(CampaignGoal)
  goal?: CampaignGoal;
}

export class ListCampaignsQueryDto {
  @IsOptional()
  @IsIn(['live', 'past', 'cancelled'])
  tab?: 'live' | 'past' | 'cancelled';

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

export class ReportViewDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(24 * 3600)
  watchSeconds: number;

  // Present when the item was served in a boost slot (feed item `boost.campaignId`).
  @IsOptional()
  @IsMongoId()
  campaignId?: string;
}

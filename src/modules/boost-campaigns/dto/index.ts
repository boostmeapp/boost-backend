import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
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

  // 'worldwide' or an ISO 3166-1 alpha-2 code. Optional so clients built
  // before location existed keep working — it defaults worldwide.
  @IsOptional()
  @IsString()
  @Matches(/^(worldwide|[A-Za-z]{2})$/, {
    message: 'location must be "worldwide" or a two-letter country code',
  })
  location?: string;
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

  // A whole number of days anywhere in range — duration is a slider, not a
  // fixed set of presets.
  @Type(() => Number)
  @IsInt()
  @Min(BOOST_CONFIG.DURATION_MIN)
  @Max(BOOST_CONFIG.DURATION_MAX)
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

import {
  AudienceSize,
  TargetAge,
  TargetGender,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';

/**
 * Boost campaign rules. Served to the app via GET /boost/config so the client
 * never hardcodes prices or options.
 */
export const BOOST_CONFIG = {
  COINS_MIN: 100,
  COINS_MAX: 1000,
  COINS_STEP: 50,
  DURATIONS: [1, 3, 7, 14],

  // A view qualifies after this many seconds (or half of a shorter video).
  QUALIFIED_VIEW_SECONDS: 3,

  // Delivery
  BOOST_SLOT_EVERY: 5, // one boosted item per 5 feed items
  MAX_SERVES_PER_VIEWER_PER_DAY: 3, // per campaign
  MIN_MINUTES_BETWEEN_SERVES: 10, // stops the same boost repeating page after page

  ACTIVE_WINDOW_DAYS: 30, // "eligible" = opened the app within this window

  // Caches
  ACTIVE_CAMPAIGNS_TTL_SECONDS: 60,
  AUDIENCE_COUNT_TTL_SECONDS: 600,

  // Abuse guard on view reports
  MAX_VIEW_REPORTS_PER_MINUTE: 30,
};

// Audience size = the share of the eligible audience the boost targets.
export const AUDIENCE_SHARE: Record<AudienceSize, number> = {
  [AudienceSize.SPECIFIC]: 0.2,
  [AudienceSize.BALANCED]: 0.5,
  [AudienceSize.WIDE]: 1,
};

export const ACTIVE_CAMPAIGNS_CACHE_KEY = 'boost:active';

export const BOOST_TIERS = [
  { key: 'low', label: 'Low', coins: 100 },
  { key: 'balanced', label: 'Balanced', coins: 500 },
  { key: 'high', label: 'High', coins: 1000 },
];

export const AUDIENCE_SIZE_OPTIONS = [
  { key: AudienceSize.SPECIFIC, label: 'Specific' },
  { key: AudienceSize.BALANCED, label: 'Balanced' },
  { key: AudienceSize.WIDE, label: 'Wide' },
];

// Buckets overlap on purpose — they mirror the app's options.
export const AGE_OPTIONS = [
  { key: TargetAge.ALL, label: 'All', min: 0, max: null },
  { key: TargetAge.UNDER_18, label: 'Under 18', min: 13, max: 17 },
  { key: TargetAge.ABOVE_18, label: 'Above 18+', min: 18, max: null },
  { key: TargetAge.FORTY_PLUS, label: '40 - 80+', min: 40, max: null },
];

export const GENDER_OPTIONS = [
  { key: TargetGender.ALL, label: 'All' },
  { key: TargetGender.MEN, label: 'Men' },
  { key: TargetGender.WOMEN, label: 'Women' },
  { key: TargetGender.OTHERS, label: 'Others' },
];

// Profile gender values (Edit Profile) → targeting bucket.
export const PROFILE_GENDER_TO_TARGET: Record<string, TargetGender> = {
  male: TargetGender.MEN,
  female: TargetGender.WOMEN,
  other: TargetGender.OTHERS,
  prefer_not_to_say: TargetGender.OTHERS,
};

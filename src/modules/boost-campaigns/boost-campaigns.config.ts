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
  // Budget is chosen as a daily figure in GBP over a number of days, the way
  // the original Promote screen worked; the app converts that to coins at
  // ENV.COINS_PER_GBP before calling estimate/create. These coin bounds are
  // what that conversion can produce: BUDGET_PER_DAY_MAX × DURATION_MAX × 100.
  COINS_MIN: 100,
  COINS_MAX: 3_000_000,
  COINS_STEP: 50,

  // £ per day. The slider steps in pounds, not coins — 3,000,000 coins at
  // COINS_STEP would be 60,000 slider positions.
  BUDGET_PER_DAY_MIN: 1,
  BUDGET_PER_DAY_MAX: 1000,
  BUDGET_PER_DAY_STEP: 1,

  // Any whole number of days, rather than a fixed set, so duration is a
  // slider like the budget.
  DURATION_MIN: 1,
  DURATION_MAX: 30,

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

/**
 * Countries a boost can target, served via GET /boost/config so the app does
 * not ship its own list. `worldwide` is the default and means no restriction.
 *
 * Deliberately a short list of the markets the app actually operates in
 * rather than all ~250 ISO countries: an advertiser scrolling 250 rows to
 * find one is worse than asking for a country to be added. Extend as needed —
 * the schema stores a plain string, so nothing else changes.
 */
export const LOCATION_OPTIONS = [
  { key: 'worldwide', label: 'Worldwide' },
  { key: 'GB', label: 'United Kingdom' },
  { key: 'US', label: 'United States' },
  { key: 'CA', label: 'Canada' },
  { key: 'IE', label: 'Ireland' },
  { key: 'AU', label: 'Australia' },
  { key: 'NZ', label: 'New Zealand' },
  { key: 'DE', label: 'Germany' },
  { key: 'FR', label: 'France' },
  { key: 'ES', label: 'Spain' },
  { key: 'IT', label: 'Italy' },
  { key: 'NL', label: 'Netherlands' },
  { key: 'BE', label: 'Belgium' },
  { key: 'PT', label: 'Portugal' },
  { key: 'SE', label: 'Sweden' },
  { key: 'NO', label: 'Norway' },
  { key: 'DK', label: 'Denmark' },
  { key: 'FI', label: 'Finland' },
  { key: 'IS', label: 'Iceland' },
  { key: 'AT', label: 'Austria' },
  { key: 'CH', label: 'Switzerland' },
  { key: 'PL', label: 'Poland' },
  { key: 'CZ', label: 'Czechia' },
  { key: 'SK', label: 'Slovakia' },
  { key: 'HU', label: 'Hungary' },
  { key: 'RO', label: 'Romania' },
  { key: 'BG', label: 'Bulgaria' },
  { key: 'GR', label: 'Greece' },
  { key: 'HR', label: 'Croatia' },
  { key: 'RS', label: 'Serbia' },
  { key: 'UA', label: 'Ukraine' },
  { key: 'TR', label: 'Turkey' },
  { key: 'IL', label: 'Israel' },
  { key: 'AE', label: 'United Arab Emirates' },
  { key: 'SA', label: 'Saudi Arabia' },
  { key: 'QA', label: 'Qatar' },
  { key: 'KW', label: 'Kuwait' },
  { key: 'BH', label: 'Bahrain' },
  { key: 'OM', label: 'Oman' },
  { key: 'JO', label: 'Jordan' },
  { key: 'EG', label: 'Egypt' },
  { key: 'MA', label: 'Morocco' },
  { key: 'DZ', label: 'Algeria' },
  { key: 'TN', label: 'Tunisia' },
  { key: 'NG', label: 'Nigeria' },
  { key: 'GH', label: 'Ghana' },
  { key: 'KE', label: 'Kenya' },
  { key: 'TZ', label: 'Tanzania' },
  { key: 'UG', label: 'Uganda' },
  { key: 'ET', label: 'Ethiopia' },
  { key: 'ZA', label: 'South Africa' },
  { key: 'PK', label: 'Pakistan' },
  { key: 'IN', label: 'India' },
  { key: 'BD', label: 'Bangladesh' },
  { key: 'LK', label: 'Sri Lanka' },
  { key: 'NP', label: 'Nepal' },
  { key: 'CN', label: 'China' },
  { key: 'JP', label: 'Japan' },
  { key: 'KR', label: 'South Korea' },
  { key: 'TW', label: 'Taiwan' },
  { key: 'HK', label: 'Hong Kong' },
  { key: 'SG', label: 'Singapore' },
  { key: 'MY', label: 'Malaysia' },
  { key: 'ID', label: 'Indonesia' },
  { key: 'TH', label: 'Thailand' },
  { key: 'VN', label: 'Vietnam' },
  { key: 'PH', label: 'Philippines' },
  { key: 'BR', label: 'Brazil' },
  { key: 'MX', label: 'Mexico' },
  { key: 'AR', label: 'Argentina' },
  { key: 'CL', label: 'Chile' },
  { key: 'CO', label: 'Colombia' },
  { key: 'PE', label: 'Peru' },
];

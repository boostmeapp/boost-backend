import { AudienceSize } from '../../database/schemas/boost-campaign/boost-campaign.schema';
import { AUDIENCE_SHARE } from './boost-campaigns.config';

/**
 * Boost reach maths, kept pure so it can be tested on its own.
 *
 *   audienceReach = floor(eligibleAudience × share[audienceSize])
 *   requestedViews = coins × viewsPerCoin
 *   finalReach     = min(audienceReach, requestedViews)
 *   coinsRequired  = ceil(finalReach / viewsPerCoin)
 */

/**
 * Share of the eligible audience the chosen size targets. Never rounds a
 * non-empty audience down to 0 — "3 people × 20%" still lets you boost to 1.
 */
export const audienceReach = (
  eligibleAudience: number,
  size: AudienceSize,
): number => {
  if (eligibleAudience <= 0) return 0;
  const share = AUDIENCE_SHARE[size] ?? AUDIENCE_SHARE[AudienceSize.BALANCED];
  return Math.max(1, Math.floor(eligibleAudience * share));
};

export const requestedViews = (coins: number, viewsPerCoin: number): number =>
  coins * viewsPerCoin;

export const finalReach = (audience: number, requested: number): number =>
  Math.min(audience, requested);

export const coinsRequired = (reach: number, viewsPerCoin: number): number =>
  Math.ceil(reach / viewsPerCoin);

export const calculateReach = (input: {
  eligibleAudience: number;
  audienceSize: AudienceSize;
  coins: number;
  viewsPerCoin: number;
}) => {
  const audience = audienceReach(input.eligibleAudience, input.audienceSize);
  const requested = requestedViews(input.coins, input.viewsPerCoin);
  const reach = finalReach(audience, requested);

  return {
    audienceReach: audience,
    requestedViews: requested,
    finalReach: reach,
    coinsRequired: coinsRequired(reach, input.viewsPerCoin),
  };
};

import { AudienceSize } from '../../database/schemas/boost-campaign/boost-campaign.schema';
import {
  audienceReach,
  calculateReach,
  coinsRequired,
  finalReach,
  requestedViews,
} from './boost-reach';

describe('boost reach calculation', () => {
  describe('audienceReach', () => {
    it('targets 20% / 50% / 100% of the eligible audience', () => {
      expect(audienceReach(100, AudienceSize.SPECIFIC)).toBe(20);
      expect(audienceReach(100, AudienceSize.BALANCED)).toBe(50);
      expect(audienceReach(100, AudienceSize.WIDE)).toBe(100);
    });

    it('floors partial people (47 eligible → 9 / 23 / 47)', () => {
      expect(audienceReach(47, AudienceSize.SPECIFIC)).toBe(9);
      expect(audienceReach(47, AudienceSize.BALANCED)).toBe(23);
      expect(audienceReach(47, AudienceSize.WIDE)).toBe(47);
    });

    it('never rounds a non-empty audience down to 0', () => {
      expect(audienceReach(3, AudienceSize.SPECIFIC)).toBe(1);
    });

    it('is 0 when nobody is eligible', () => {
      expect(audienceReach(0, AudienceSize.WIDE)).toBe(0);
    });
  });

  it('requestedViews = coins × viewsPerCoin', () => {
    expect(requestedViews(100, 4)).toBe(400);
    expect(requestedViews(500, 4)).toBe(2000);
    expect(requestedViews(1000, 4)).toBe(4000);
  });

  it('finalReach is limited by both audience and purchased views', () => {
    expect(finalReach(50, 2000)).toBe(50);
    expect(finalReach(5000, 2000)).toBe(2000);
  });

  it('coinsRequired = ceil(finalReach / viewsPerCoin)', () => {
    expect(coinsRequired(47, 4)).toBe(12);
    expect(coinsRequired(2000, 4)).toBe(500);
    expect(coinsRequired(0, 4)).toBe(0);
  });

  it('puts it together: balanced, 47 eligible, 500 coins', () => {
    expect(
      calculateReach({
        eligibleAudience: 47,
        audienceSize: AudienceSize.BALANCED,
        coins: 500,
        viewsPerCoin: 4,
      }),
    ).toEqual({
      audienceReach: 23,
      requestedViews: 2000,
      finalReach: 23,
      coinsRequired: 6,
    });
  });
});

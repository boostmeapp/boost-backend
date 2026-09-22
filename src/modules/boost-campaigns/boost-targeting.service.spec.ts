import {
  BoostTargetingService,
  TargetableViewer,
} from './boost-targeting.service';
import {
  AudienceSize,
  CampaignTargeting,
  TargetAge,
  TargetGender,
} from '../../database/schemas/boost-campaign/boost-campaign.schema';

const YEAR = 365.25 * 24 * 3600 * 1000;
const bornYearsAgo = (years: number) => new Date(Date.now() - years * YEAR);

const targeting = (
  over: Partial<CampaignTargeting> = {},
): CampaignTargeting => ({
  audienceSize: AudienceSize.BALANCED,
  age: TargetAge.ABOVE_18,
  gender: TargetGender.ALL,
  ...over,
});

const viewer = (over: Partial<TargetableViewer> = {}): TargetableViewer => ({
  _id: 'v1',
  ...over,
});

describe('BoostTargetingService.matchesViewer', () => {
  const service = new BoostTargetingService({} as any, {} as any);

  it('matches everyone for an all-gender, balanced campaign with no profile data', () => {
    expect(service.matchesViewer(targeting(), viewer())).toBe(true);
  });

  it('applies the same filters at every audience size', () => {
    const base = { age: TargetAge.UNDER_18, gender: TargetGender.WOMEN };
    const adultMan = viewer({ dob: bornYearsAgo(40), gender: 'male' });

    for (const audienceSize of Object.values(AudienceSize)) {
      expect(
        service.matchesViewer(targeting({ ...base, audienceSize }), adultMan),
      ).toBe(false);
    }
  });

  describe('age', () => {
    it('matches every age when age is "all"', () => {
      const all = targeting({ age: TargetAge.ALL });
      expect(
        service.matchesViewer(all, viewer({ dob: bornYearsAgo(15) })),
      ).toBe(true);
      expect(
        service.matchesViewer(all, viewer({ dob: bornYearsAgo(60) })),
      ).toBe(true);
    });

    it('keeps under-18s out of an above-18 campaign', () => {
      expect(
        service.matchesViewer(targeting(), viewer({ dob: bornYearsAgo(16) })),
      ).toBe(false);
      expect(
        service.matchesViewer(targeting(), viewer({ dob: bornYearsAgo(25) })),
      ).toBe(true);
    });

    it('caps the under-18 bucket at 17', () => {
      const teens = targeting({ age: TargetAge.UNDER_18 });
      expect(
        service.matchesViewer(teens, viewer({ dob: bornYearsAgo(15) })),
      ).toBe(true);
      expect(
        service.matchesViewer(teens, viewer({ dob: bornYearsAgo(18.2) })),
      ).toBe(false);
    });

    it('never excludes someone without a dob, at any audience size', () => {
      const specific = targeting({ audienceSize: AudienceSize.SPECIFIC });
      expect(service.matchesViewer(specific, viewer())).toBe(true);
      expect(service.matchesViewer(targeting(), viewer())).toBe(true);
    });

    it('still applies a known age for specific campaigns', () => {
      const specific = targeting({ audienceSize: AudienceSize.SPECIFIC });
      expect(
        service.matchesViewer(specific, viewer({ dob: bornYearsAgo(15) })),
      ).toBe(false);
    });

    it('applies age for wide campaigns too', () => {
      const wide = targeting({ audienceSize: AudienceSize.WIDE });
      expect(
        service.matchesViewer(wide, viewer({ dob: bornYearsAgo(14) })),
      ).toBe(false);
    });
  });

  describe('gender', () => {
    const women = targeting({ gender: TargetGender.WOMEN });

    it('maps profile values to targeting buckets', () => {
      expect(service.matchesViewer(women, viewer({ gender: 'female' }))).toBe(
        true,
      );
      expect(service.matchesViewer(women, viewer({ gender: 'male' }))).toBe(
        false,
      );
      expect(
        service.matchesViewer(
          targeting({ gender: TargetGender.OTHERS }),
          viewer({ gender: 'prefer_not_to_say' }),
        ),
      ).toBe(true);
    });

    it('never excludes someone without a gender, at any audience size', () => {
      expect(service.matchesViewer(women, viewer())).toBe(true);
      expect(
        service.matchesViewer(
          { ...women, audienceSize: AudienceSize.SPECIFIC },
          viewer(),
        ),
      ).toBe(true);
    });
  });
});

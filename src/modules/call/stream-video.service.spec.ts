import { StreamVideoService } from './stream-video.service';
import { ENV } from '../../config';

const provider = (overrides: Record<string, unknown>) => ({
  type: 'apn',
  apn_supports_voip_notifications: true,
  ...overrides,
});

describe('StreamVideoService push provider check', () => {
  let service: StreamVideoService;
  let client: { getApp: jest.Mock; listPushProviders: jest.Mock };

  beforeAll(() => {
    ENV.init({ get: (_key: string, fallback: unknown) => fallback } as any);
  });

  beforeEach(() => {
    client = {
      getApp: jest.fn().mockResolvedValue({}),
      listPushProviders: jest.fn(),
    };
    service = new StreamVideoService();
    // Bypass onModuleInit; inject the mocked client directly.
    (service as any).client = client;
    (service as any).status.enabled = true;
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  });

  const withProviders = (push_providers: unknown[]) =>
    client.listPushProviders.mockResolvedValue({ push_providers });

  it('reports ok when all three configured providers exist and are usable', async () => {
    withProviders([
      provider({ name: 'boostra-voip-sandbox' }),
      provider({ name: 'boostra-voip-production' }),
      provider({ name: 'boostra-android', type: 'firebase', apn_supports_voip_notifications: undefined }),
    ]);

    const { push, reachable } = await service.getStatus(true);

    expect(reachable).toBe(true);
    expect(push).toEqual({
      apnSandbox: { name: 'boostra-voip-sandbox', state: 'ok' },
      apnProduction: { name: 'boostra-voip-production', state: 'ok' },
      firebase: { name: 'boostra-android', state: 'ok' },
    });
  });

  it('flags missing, disabled, and non-VoIP providers', async () => {
    withProviders([
      provider({ name: 'boostra-voip-sandbox', apn_supports_voip_notifications: false }),
      provider({ name: 'boostra-voip-production', disabled_at: new Date() }),
    ]);

    const { push } = await service.getStatus(true);

    expect(push?.apnSandbox.state).toBe('not_voip');
    expect(push?.apnProduction.state).toBe('disabled');
    expect(push?.firebase.state).toBe('missing');
  });

  it('matches on type too — an APNs provider named like the Firebase one does not count', async () => {
    withProviders([provider({ name: 'boostra-android' })]);

    const { push } = await service.getStatus(true);

    expect(push?.firebase.state).toBe('missing');
  });

  it('reports unknown, and keeps Stream up, when listing providers fails', async () => {
    client.listPushProviders.mockRejectedValue(new Error('403'));

    const { push, reachable } = await service.getStatus(true);

    expect(reachable).toBe(true);
    expect(push?.apnProduction.state).toBe('unknown');
  });

  it('warns once per state change, not on every probe', async () => {
    withProviders([]);
    const warn = (service as any).logger.warn as jest.Mock;

    await service.getStatus(true);
    await service.getStatus(true);

    expect(warn).toHaveBeenCalledTimes(3); // one per provider, first probe only
  });
});

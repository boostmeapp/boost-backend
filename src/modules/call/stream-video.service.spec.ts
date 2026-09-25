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

describe('StreamVideoService app identity check (Iteration 13)', () => {
  const env: Record<string, string> = {};
  let service: StreamVideoService;
  let getApp: jest.Mock;
  const verify = () => (service as any).verifyAppIdentity() as Promise<void>;

  beforeAll(() => {
    ENV.init({ get: (key: string, fallback: unknown) => env[key] ?? fallback } as any);
  });

  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    getApp = jest.fn().mockResolvedValue({ app: { id: 111 } });
    service = new StreamVideoService();
    (service as any).client = { getApp };
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation(() => undefined);
    }
  });

  it('2. refuses a staging/dev backend holding PRODUCTION Stream credentials', async () => {
    env.NODE_ENV = 'development';
    env.STREAM_PRODUCTION_APP_ID = '111';

    await expect(verify()).rejects.toThrow(/PRODUCTION Stream app \(111\)/);
  });

  it('refuses production on any other app', async () => {
    env.NODE_ENV = 'production';
    env.STREAM_PRODUCTION_APP_ID = '999';

    await expect(verify()).rejects.toThrow(/production is using Stream app 111/);
  });

  it('refuses when STREAM_APP_ID disagrees with the key\'s real app', async () => {
    env.STREAM_PRODUCTION_APP_ID = '999';
    env.STREAM_APP_ID = '222';

    await expect(verify()).rejects.toThrow(/STREAM_APP_ID is 222 but the API key belongs to app 111/);
  });

  it('passes on the right app in each environment', async () => {
    env.STREAM_PRODUCTION_APP_ID = '999';
    env.NODE_ENV = 'development';
    await expect(verify()).resolves.toBeUndefined();

    env.STREAM_PRODUCTION_APP_ID = '111';
    env.NODE_ENV = 'production';
    await expect(verify()).resolves.toBeUndefined();
  });

  it('skipped when STREAM_PRODUCTION_APP_ID is unset (local dev) — no network call', async () => {
    await expect(verify()).resolves.toBeUndefined();
    expect(getApp).not.toHaveBeenCalled();
  });

  it('Stream unreachable at boot: warns and boots, never blocks a deploy', async () => {
    env.STREAM_PRODUCTION_APP_ID = '111';
    getApp.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(verify()).resolves.toBeUndefined();
  });
});


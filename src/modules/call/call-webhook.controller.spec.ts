import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StreamClient } from '@stream-io/node-sdk';
import { createHmac } from 'crypto';
import request from 'supertest';
import { CallWebhookController } from './call-webhook.controller';
import { CallWebhookService } from './call-webhook.service';
import { StreamVideoService } from './stream-video.service';
import { jsonWithRawBody } from '../../common/middleware/json-with-raw-body';

/**
 * Over real HTTP, through the same body parser main.ts uses and the real SDK
 * signature check. Signing is local HMAC with a test secret — nothing here
 * talks to Stream.
 */
describe('POST /calls/webhook', () => {
  const SECRET = 'test-webhook-secret';
  let app: INestApplication;
  let handle: jest.Mock;

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');
  const post = (body: string, signature?: string) => {
    const req = request(app.getHttpServer())
      .post('/calls/webhook')
      .set('Content-Type', 'application/json');
    if (signature !== undefined) req.set('X-Signature', signature);
    return req.send(body);
  };

  // Deliberately odd spacing and key order: a re-serialised body would differ
  // from these bytes and fail verification — exactly the bug raw body prevents.
  const body = '{"type":"call.ended",  "call_cid":"default:abc","created_at":"2026-09-25T12:00:00Z"}';

  beforeEach(async () => {
    handle = jest.fn().mockResolvedValue('applied');
    const streamVideo = new StreamVideoService();
    (streamVideo as any).client = new StreamClient('test-key', SECRET);

    const moduleRef = await Test.createTestingModule({
      controllers: [CallWebhookController],
      providers: [
        // Only the real signature check — a plain wrapper so Nest doesn't run
        // the service's onModuleInit (which needs ENV) on it.
        {
          provide: StreamVideoService,
          useValue: {
            verifyAndParseWebhook: (raw: Buffer, sig: string) =>
              streamVideo.verifyAndParseWebhook(raw, sig),
          },
        },
        { provide: CallWebhookService, useValue: { handle } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
    app.use(jsonWithRawBody(['/calls/webhook']));
    await app.init();
  });

  afterEach(() => app.close());

  it('1. a correctly signed request → 200, event handed over parsed', async () => {
    const res = await post(body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, outcome: 'applied' });
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'call.ended', call_cid: 'default:abc' }),
    );
  });

  it('2. one tampered byte → 401, never processed', async () => {
    const tampered = body.replace('call.ended', 'call.endeD');

    const res = await post(tampered, sign(body));

    expect(res.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it('a missing signature → 401', async () => {
    expect((await post(body)).status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it('a signature made with another secret → 401', async () => {
    const forged = createHmac('sha256', 'wrong').update(body).digest('hex');

    expect((await post(body, forged)).status).toBe(401);
  });

  it('3. the same valid event three times → three 200s (idempotency is in applyTransition)', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post(body, sign(body))).status).toBe(200);
    }
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it('a handler failure after verification still returns 200, so Stream does not retry-storm', async () => {
    handle.mockRejectedValue(new Error('Mongo down'));
    jest.spyOn((app.get(CallWebhookController) as any).logger, 'error').mockImplementation(() => undefined);

    const res = await post(body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, outcome: 'error' });
  });
});

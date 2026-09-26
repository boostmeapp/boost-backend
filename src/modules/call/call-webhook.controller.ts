import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { StreamVideoService } from './stream-video.service';
import { CallWebhookService, StreamCallEvent } from './call-webhook.service';

/**
 * Stream → us. Public (Stream can't present a Boostra JWT), so the HMAC
 * signature is the only authentication: nothing is processed unverified.
 */
@Controller('calls/webhook')
@Public()
@SkipThrottle() // Stream legitimately bursts.
export class CallWebhookController {
  private readonly logger = new Logger(CallWebhookController.name);

  constructor(
    private readonly streamVideo: StreamVideoService,
    private readonly webhooks: CallWebhookService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-signature') signature?: string,
  ) {
    let event: StreamCallEvent;
    try {
      if (!req.rawBody || !signature) throw new Error('missing body or signature');
      event = this.streamVideo.verifyAndParseWebhook(req.rawBody, signature) as StreamCallEvent;
    } catch (err) {
      this.logger.warn(`Rejected unverified Stream webhook from ${req.ip}: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // From here on, always 200. A non-2xx makes Stream retry, and a handler
    // bug must not turn into a retry storm; the sweeper (Iteration 9) is the
    // backstop for anything missed.
    try {
      const outcome = await this.webhooks.handle(event);
      return { received: true, outcome };
    } catch (err) {
      this.logger.error(
        `Webhook ${event.type} (${event.call_cid}) failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return { received: true, outcome: 'error' };
    }
  }
}

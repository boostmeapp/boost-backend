import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// The single place in the backend that knows where media is served from.
@Injectable()
export class MediaUrlService {
  private readonly base: string;
  private readonly s3Origin: string;

  constructor(config: ConfigService) {
    const bucket = config.get<string>('AWS_S3_BUCKET');
    const region = config.get<string>('AWS_REGION') || 'us-east-1';
    this.s3Origin = `https://${bucket}.s3.${region}.amazonaws.com/`;

    // While AWS_CLOUDFRONT_DOMAIN holds the REPLACE_WITH_* placeholder, behaviour is identical to today.
    const cdn = (config.get<string>('AWS_CLOUDFRONT_DOMAIN') || '').trim();
    const host = cdn.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

    this.base =
      host && !host.startsWith('REPLACE_WITH')
        ? `https://${host}/`
        : this.s3Origin;
  }

  /** S3 key -> absolute URL. Absolute S3 URLs are rewritten onto the current host. */
  toUrl(keyOrUrl?: string | null): string | null {
    if (!keyOrUrl) return null;
    const v = String(keyOrUrl).trim();
    if (!v || v === 'null' || v === 'undefined') return null;

    if (/^https?:\/\//i.test(v)) {
      return v.startsWith(this.s3Origin)
        ? this.base + v.slice(this.s3Origin.length)
        : v;
    }
    return this.base + v.replace(/^\/+/, '');
  }
}

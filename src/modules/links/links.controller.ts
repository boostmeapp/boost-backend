import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import { Public } from '../../common/decorators';
import { Video } from '../../database/schemas/video/video.schema';
import { MediaUrlService } from '../../common/services/media-url.service';
import { ENV } from '../../config';

/**
 * Everything a shared link needs, served from this API because it is the host
 * we control:
 *
 *   /.well-known/apple-app-site-association   iOS universal links
 *   /.well-known/assetlinks.json              Android app links
 *   /video/:id                                the page a link lands on
 *
 * All three sit OUTSIDE the /api prefix (see main.ts `exclude`), because Apple
 * and Google only fetch them from the domain root.
 */
@Controller()
export class LinksController {
  constructor(
    @InjectModel(Video.name) private readonly videoModel: Model<Video>,
    private readonly mediaUrl: MediaUrlService,
  ) {}

  @Get('.well-known/apple-app-site-association')
  @Public()
  @Header('Content-Type', 'application/json')
  appleAppSiteAssociation() {
    const appId = `${ENV.APPLE_TEAM_ID}.${ENV.IOS_BUNDLE_ID}`;

    return {
      applinks: {
        // `details` replaces the old apps/paths pair; both keys stay for older iOS.
        apps: [],
        details: [
          {
            appIDs: [appId],
            appID: appId,
            components: [{ '/': '/video/*', comment: 'Shared videos' }],
            paths: ['/video/*'],
          },
        ],
      },
    };
  }

  @Get('.well-known/assetlinks.json')
  @Public()
  @Header('Content-Type', 'application/json')
  assetLinks() {
    const fingerprints = ENV.ANDROID_CERT_FINGERPRINTS;

    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ENV.ANDROID_PACKAGE,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ];
  }

  /**
   * Where a shared link lands. With the app installed the OS opens it before
   * this page is ever fetched; otherwise it shows the video's details, tries
   * the app's scheme once, and offers the stores.
   */
  @Get('video/:id')
  @Public()
  async videoPage(@Param('id') id: string, @Res() res: Response) {
    const video = Types.ObjectId.isValid(id)
      ? await this.videoModel
          .findById(id)
          .select('title description thumbnailUrl thumbnailKey user')
          .populate('user', 'username firstName lastName')
          .lean()
      : null;

    const owner: any = video?.user;
    const author =
      owner?.username ||
      `${owner?.firstName ?? ''} ${owner?.lastName ?? ''}`.trim() ||
      'Boostra';

    const title = video?.title || 'Watch on Boostra';
    const description = video?.description || `A video shared by ${author}.`;
    const image = this.mediaUrl.toUrl(video?.thumbnailKey || video?.thumbnailUrl) || '';
    const deepLink = `${ENV.APP_DEEP_LINK_SCHEME}://video/${id}`;

    res.status(video ? 200 : 404).type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · Boostra</title>
<meta property="og:type" content="video.other" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
${image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#0f0f14; color:#efeef0; padding:24px; }
  .card { max-width:420px; width:100%; text-align:center; }
  .thumb { width:100%; border-radius:16px; margin-bottom:20px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#98949c; margin:0 0 24px; }
  a.btn { display:block; padding:14px 20px; border-radius:999px; text-decoration:none;
          font-weight:600; margin-bottom:12px; background:#6617e6; color:#fff; }
  a.store { background:transparent; border:1px solid #2a2a35; color:#efeef0; }
</style>
</head>
<body>
  <div class="card">
    ${image ? `<img class="thumb" src="${escapeHtml(image)}" alt="" />` : ''}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(video ? `Shared by ${author}` : 'This video is no longer available.')}</p>
    ${video ? `<a class="btn" href="${deepLink}">Open in Boostra</a>` : ''}
    <a class="btn store" href="https://apps.apple.com/app/id${ENV.IOS_APP_STORE_ID}">Get it on the App Store</a>
    <a class="btn store" href="https://play.google.com/store/apps/details?id=${ENV.ANDROID_PACKAGE}">Get it on Google Play</a>
  </div>
  <script>
    // One silent attempt at the app; harmless when it isn't installed.
    setTimeout(function () { window.location.href = ${JSON.stringify(deepLink)}; }, 50);
  </script>
</body>
</html>`);
  }
}

const escapeHtml = (value: string) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

import { Controller, Get, Header } from '@nestjs/common';

import { Public } from '../../common/decorators';
import { ENV } from '../../config';

/**
 * The verification files a shared link needs, served from this API because it
 * is the host we control:
 *
 *   /.well-known/apple-app-site-association   iOS universal links
 *   /.well-known/assetlinks.json              Android app links
 *
 * The landing page itself (/videos/:id) is served as middleware in main.ts:
 * excluding that path from the /api prefix here would also strip the prefix
 * from the real API's videos/:id routes.
 *
 * Both sit OUTSIDE the /api prefix (see main.ts `exclude`), because Apple and
 * Google only fetch them from the domain root.
 */
@Controller()
export class LinksController {
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
            components: [{ '/': '/videos/*', comment: 'Shared videos' }],
            paths: ['/videos/*'],
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
}

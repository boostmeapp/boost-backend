import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../../common/decorators';
import { ENV } from '../../config';

@Controller()
export class ResetLinkController {
  /**
   * Public landing page for the password-reset email link.
   * Tries to open the mobile app via deep link, falls back to instructions
   * for entering the OTP manually.
   */
  @Public()
  @Get('reset-password')
  @Header('Content-Type', 'text/html; charset=utf-8')
  reset(
    @Query('token') token?: string,
    @Query('email') email?: string,
  ): string {
    const safeToken = (token || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeEmail = encodeURIComponent(email || '');
    const scheme = ENV.APP_DEEP_LINK_SCHEME || 'boostme';
    const deepLink = `${scheme}://reset-password?token=${safeToken}&email=${safeEmail}`;
    const appName = ENV.APP_NAME || 'BoostMe';

    return `<!doctype html><html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${appName} — Reset password</title>
<style>
  body { margin:0; padding:0; min-height:100vh; background:#0F1C22; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#E6EEF2; display:flex; align-items:center; justify-content:center; }
  .card { max-width:480px; margin:24px; padding:32px; background:#152832; border-radius:14px; }
  h1 { color:#00D1FF; margin:0 0 8px; font-size:22px; }
  h2 { color:#FFFFFF; font-size:18px; margin:0 0 12px; }
  p { color:#A0AAB0; line-height:1.5; }
  a.btn { display:inline-block; padding:14px 28px; background:#00D1FF; color:#0F1C22; font-weight:700; text-decoration:none; border-radius:10px; margin-top:12px; }
  .muted { color:#7A8A92; font-size:12px; margin-top:24px; word-break:break-all; }
</style>
</head><body>
<div class="card">
  <h1>${appName}</h1>
  <h2>Reset your password</h2>
  <p>Open the ${appName} app on your phone, go to <b>Forgot password</b>, and enter the 6-digit code from the email we just sent you.</p>
  <p>If the app is installed on this device, tap the button below to open it directly.</p>
  <a class="btn" href="${deepLink}">Open ${appName} app</a>
  <p class="muted">If the button does not work, copy this link into the app: <br/>${deepLink}</p>
</div>
<script>
  // Try to auto-open the app on mobile
  setTimeout(function () {
    window.location.href = ${JSON.stringify(deepLink)};
  }, 400);
</script>
</body></html>`;
  }
}

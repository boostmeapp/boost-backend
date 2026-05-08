import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { VerificationService } from './verification.service';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  EmailDto,
  VerifyEmailDto,
  ResetPasswordDto,
  VerifyPasswordDto,
  ConfirmAccountDeleteDto,
} from './dto';
import { JwtAuthGuard } from '../../common/guards';
import { Public, CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly verificationService: VerificationService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refreshTokens(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshTokens(refreshTokenDto.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@CurrentUser() user: User) {
    await this.authService.logout(user.id);
    return { message: 'Logged out successfully' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getCurrentUser(@CurrentUser() user: User) {
    return user;
  }

  // ----- Email verification -----
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('send-verification-otp')
  async sendVerificationOtp(@Body() body: EmailDto) {
    return this.verificationService.sendEmailVerificationOtp(body.email);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  async verifyEmail(@Body() body: VerifyEmailDto) {
    return this.verificationService.verifyEmailOtp(body.email, body.otp);
  }

  // ----- Forgot / reset password -----
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(@Body() body: EmailDto) {
    return this.verificationService.sendPasswordResetEmail(body.email);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(@Body() body: ResetPasswordDto) {
    return this.verificationService.resetPassword({
      email: body.email,
      otp: body.otp,
      token: body.token,
      newPassword: body.newPassword,
    });
  }

  // ----- Re-auth (used before sensitive screens) -----
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('verify-password')
  async verifyPassword(
    @CurrentUser() user: User,
    @Body() body: VerifyPasswordDto,
  ) {
    return this.verificationService.verifyPassword(user.id, body.password);
  }

  // ----- Account deletion -----
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('request-account-deletion')
  async requestAccountDeletion(@CurrentUser() user: User) {
    return this.verificationService.sendAccountDeletionOtp(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('confirm-account-deletion')
  async confirmAccountDeletion(
    @CurrentUser() user: User,
    @Body() body: ConfirmAccountDeleteDto,
  ) {
    const result = await this.verificationService.confirmAccountDeletion(
      user.id,
      body.otp,
      body.password,
    );
    await this.authService.logout(user.id).catch(() => undefined);
    return result;
  }
}

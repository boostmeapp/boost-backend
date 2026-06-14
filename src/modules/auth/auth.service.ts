import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { TokenService, AuthResponse } from './token.service';
import { User } from '../../database/schemas/user/user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Follow } from 'src/database/schemas/follow/follow.schema';
import { VerificationService } from './verification.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
    @InjectModel(Follow.name)
    private readonly followModel: Model<Follow>,
    private readonly verificationService: VerificationService,
  ) { }

  // ✅ LOGIN VALIDATION (PRODUCTION SAFE)
  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.usersService.findByEmail(
      email.trim().toLowerCase(),
    );

    if (!user || !user.isActive) {
      return null;
    }

    if (!user.password) {
      return null;
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return null;
    }

    return user;
  }

  async register(registerDto: RegisterDto): Promise<AuthResponse> {
    const { acceptedEula, ...rest } = registerDto;
    let user = await this.usersService.create({
      ...rest,
      email: registerDto.email.trim().toLowerCase(),
      // Record EULA acceptance timestamp (App Store Guideline 1.2)
      eulaAcceptedAt: acceptedEula ? new Date() : undefined,
    } as any);

    // Auto-promote to admin if the email is configured in ADMIN_EMAILS
    user = await this.usersService.ensureAdminRole(user);

    const tokens = await this.tokenService.generateTokens(user);

    // Fire-and-forget: send verification OTP, but don't fail signup if SMTP is down.
    this.verificationService
      .sendEmailVerificationOtp(user.email)
      .catch((err) =>
        this.logger.error(
          `Failed to send signup verification email to ${user.email}`,
          err as Error,
        ),
      );

    return {
      user: {
        ...user.toObject(),
        followerCount: 0,
        followingCount: 0,
      },
      ...tokens,
    };
  }

  async login(loginDto: LoginDto): Promise<AuthResponse> {
    const user = await this.validateUser(
      loginDto.email,
      loginDto.password,
    );

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Auto-promote to admin if the email is configured in ADMIN_EMAILS
    await this.usersService.ensureAdminRole(user);

    const userId = new Types.ObjectId(user._id);

    // ✅ REAL COUNTS
    const [followers, following] = await Promise.all([
      this.followModel.countDocuments({ following: userId }),
      this.followModel.countDocuments({ follower: userId }),
    ]);

    const tokens = await this.tokenService.generateTokens(user);

    return {
      user: {
        ...user.toObject(),
        followerCount: followers,
        followingCount: following,
      },
      ...tokens,
    };
  }


  async refreshTokens(refreshToken: string): Promise<AuthResponse> {
    try {
      const payload = await this.tokenService.verifyRefreshToken(refreshToken);
      return this.tokenService.refreshTokens(payload.sub);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string): Promise<void> {
    await this.tokenService.revokeRefreshToken(userId);
  }

  async getCurrentUser(userId: string): Promise<User> {
    return this.usersService.findOne(userId);
  }
}

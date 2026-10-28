import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { TokenService, AuthResponse } from './token.service';
import { AuthProvider, User } from '../../database/schemas/user/user.schema';
import { GoogleAuthService } from './google-auth.service';
import { AppleAuthService } from './apple-auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import * as bcrypt from 'bcrypt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Follow } from 'src/database/schemas/follow/follow.schema';
import { VerificationService } from './verification.service';

type SocialProvider = AuthProvider.GOOGLE | AuthProvider.APPLE;

/** A provider-verified identity; nothing here comes from the request body unchecked. */
interface SocialIdentity {
  provider: SocialProvider;
  /** The provider's `sub` claim. */
  providerId: string;
  email?: string;
  isPrivateEmail?: boolean;
  firstName?: string;
  lastName?: string;
}

const PROVIDER_ID_FIELD: Record<SocialProvider, 'googleId' | 'appleId'> = {
  [AuthProvider.GOOGLE]: 'googleId',
  [AuthProvider.APPLE]: 'appleId',
};

/** Names from Apple arrive unsigned in the request body. */
const cleanName = (v?: string) => v?.trim().slice(0, 50) || undefined;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
    @InjectModel(Follow.name)
    private readonly followModel: Model<Follow>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly verificationService: VerificationService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly appleAuthService: AppleAuthService,
  ) { }

  /** Sign in (or sign up) with a Google ID token. */
  async loginWithGoogle(idToken: string): Promise<AuthResponse> {
    const identity = await this.googleAuthService.verify(idToken);
    return this.signInWithProvider({
      provider: AuthProvider.GOOGLE,
      providerId: identity.googleId,
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
    });
  }

  /** Sign in (or sign up) with an Apple identity token. */
  async loginWithApple(dto: AppleLoginDto): Promise<AuthResponse> {
    const identity = await this.appleAuthService.verify(
      dto.identityToken,
      dto.nonce,
    );
    return this.signInWithProvider({
      provider: AuthProvider.APPLE,
      providerId: identity.appleId,
      email: identity.email,
      isPrivateEmail: identity.isPrivateEmail,
      firstName: cleanName(dto.firstName),
      lastName: cleanName(dto.lastName),
    });
  }

  /**
   * Sign in (or sign up) with a provider-verified identity. Google and Apple
   * share this so the two can never apply different rules.
   *
   * The email address is the identity: an account that already exists for it is
   * linked and reused, never duplicated.
   */
  private async signInWithProvider(
    identity: SocialIdentity,
  ): Promise<AuthResponse> {
    const idField = PROVIDER_ID_FIELD[identity.provider];

    // Provider ID first (fastest, already linked), then email (first-time link).
    let user: User | null = await this.userModel.findOne({
      [idField]: identity.providerId,
    });

    if (!user && identity.email) {
      user = await this.userModel.findOne({ email: identity.email });
    }

    if (user) {
      this.assertUsable(user);

      const linkedId = user.get(idField) as string | undefined;
      if (!linkedId) {
        // First sign-in with this provider for an existing account. Safe to
        // link: the provider asserted the address is verified, proving ownership.
        user.set(idField, identity.providerId);
        this.logger.log(
          `Linked ${identity.provider} to existing account ${user.email}`,
        );
      } else if (linkedId !== identity.providerId) {
        // Matched by verified email, but already linked to a different
        // account at the provider. Allow it; never overwrite the link.
        this.logger.warn(
          `${identity.provider} id mismatch for ${user.email}; keeping existing link`,
        );
      }

      if (!user.authProviders?.includes(identity.provider)) {
        user.authProviders = [...(user.authProviders || []), identity.provider];
      }

      // The provider verified the address, so an unverified account becomes verified.
      if (!user.isEmailVerified) {
        user.isEmailVerified = true;
        user.emailVerifiedAt = new Date();
      }

      // Only fill blanks — never overwrite what the user has already set.
      if (!user.firstName && identity.firstName) {
        user.firstName = identity.firstName;
      }
      if (!user.lastName && identity.lastName) {
        user.lastName = identity.lastName;
      }

      await user.save();
    } else {
      if (!identity.email) {
        // Apple omits the email on repeat authorizations. With no account to
        // match, there is nothing to sign in to and nothing to create.
        throw new UnauthorizedException(
          'Apple did not share your email. On your iPhone open Settings → your name → ' +
            'Sign-In & Security → Sign in with Apple → Boostra → Stop Using, then try again.',
        );
      }

      user = await this.userModel.create({
        email: identity.email,
        [idField]: identity.providerId,
        firstName: identity.firstName,
        lastName: identity.lastName,
        isPrivateEmail: !!identity.isPrivateEmail,
        // No password: this account signs in with its provider until the user
        // sets one through the forgot-password flow.
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        authProviders: [identity.provider],
      });
      this.logger.log(
        `Created account from ${identity.provider} sign-in: ${user.email}`,
      );
    }

    await this.usersService.ensureAdminRole(user);

    const [followers, following] = await Promise.all([
      this.followModel.countDocuments({ following: user._id }),
      this.followModel.countDocuments({ follower: user._id }),
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

  /** Same account-state checks a password login performs. */
  private assertUsable(user: User) {
    if (user.isBanned) {
      throw new ForbiddenException('This account has been suspended.');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account is no longer active.');
    }
  }

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

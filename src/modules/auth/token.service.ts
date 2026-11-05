import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../../database/schemas/user/user.schema';
import { ENV } from '../../config';

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
  /** Issued-at, in seconds. Added by the signer. */
  iat?: number;
}

/**
 * Whether a token issued at `iat` predates the user's session cut-off.
 * Compared in whole seconds, as `iat` is, so the token issued in the same
 * request as the revocation stays valid.
 */
export const issuedBeforeRevocation = (user: User, iat?: number): boolean =>
  !!user.sessionsRevokedAt &&
  (iat ?? 0) < Math.floor(user.sessionsRevokedAt.getTime() / 1000);

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class TokenService {
  constructor(
    private jwtService: JwtService,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {}

  async generateTokens(user: User): Promise<Tokens> {
    const payload: TokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: ENV.JWT_SECRET,
      } as any),
      this.jwtService.signAsync(payload, {
        secret: ENV.JWT_REFRESH_SECRET,
        expiresIn: ENV.JWT_REFRESH_EXPIRES_IN,
      } as any),
    ]);

    await this.updateRefreshToken(user.id, refreshToken);

    return {
      accessToken,
      refreshToken,
    };
  }

  async updateRefreshToken(
    userId: string,
    refreshToken: string | null,
  ): Promise<void> {
    await this.userModel
      .findByIdAndUpdate(userId, { refreshToken })
      .exec();
  }

  async refreshTokens(userId: string, issuedAt?: number): Promise<AuthResponse> {
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new Error('User not found');
    }
    if (issuedBeforeRevocation(user, issuedAt)) {
      throw new Error('Session revoked');
    }
    const tokens = await this.generateTokens(user);
    return {
      user,
      ...tokens,
    };
  }

  async revokeRefreshToken(userId: string): Promise<void> {
    await this.updateRefreshToken(userId, null);
  }

  async verifyRefreshToken(token: string): Promise<TokenPayload> {
    return this.jwtService.verifyAsync(token, {
      secret: ENV.JWT_REFRESH_SECRET,
    });
  }
}

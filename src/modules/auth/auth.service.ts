import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { TokenService, AuthResponse } from './token.service';
import { User } from '../../database/schemas/user/user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
  ) {}

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
    const user = await this.usersService.create({
      ...registerDto,
      email: registerDto.email.trim().toLowerCase(),
    });

    const tokens = await this.tokenService.generateTokens(user);

    return { user, ...tokens };
  }

  async login(loginDto: LoginDto): Promise<AuthResponse> {
    const user = await this.validateUser(
      loginDto.email,
      loginDto.password,
    );

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.tokenService.generateTokens(user);

    return { user, ...tokens };
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

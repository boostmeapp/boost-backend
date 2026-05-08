import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ResetLinkController } from './reset-link.controller';
import { TokenService } from './token.service';
import { VerificationService } from './verification.service';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';
import { User, UserSchema } from '../../database/schemas/user/user.schema';
import {
  VerificationToken,
  VerificationTokenSchema,
} from '../../database/schemas/verification/verification-token.schema';
import { ENV } from '../../config';
import { Follow, FollowSchema } from '../../database/schemas/follow/follow.schema';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Follow.name, schema: FollowSchema },
      { name: VerificationToken.name, schema: VerificationTokenSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        ENV.init(configService);
        return {
          secret: ENV.JWT_SECRET,
          signOptions: {
            expiresIn: ENV.JWT_EXPIRES_IN as any,
          },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, ResetLinkController],
  providers: [
    AuthService,
    TokenService,
    VerificationService,
    LocalStrategy,
    JwtStrategy,
  ],
  exports: [AuthService, TokenService, VerificationService],
})
export class AuthModule {}

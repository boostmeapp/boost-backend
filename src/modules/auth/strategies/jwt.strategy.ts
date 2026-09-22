import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { UsersService } from '../../users/users.service';
import { RedisService } from '../../redis/redis.service';
import { User } from '../../../database/schemas/user/user.schema';
import { ENV } from '../../../config';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private usersService: UsersService,
    private redis: RedisService,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: ENV.JWT_SECRET,
    });
  }

  async validate(payload: JwtPayload) {
    // findOne throws NotFoundException, which would surface as a 404 on every
    // guarded route and hide the fact that the token itself is unusable.
    const user = await this.usersService.findOne(payload.sub).catch((err) => {
      if (err instanceof NotFoundException) return null;
      throw err;
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }

    void this.touchLastActive(payload.sub);

    return user;
  }

  /**
   * Stamps lastActiveAt at most once an hour per user (boost reach counts
   * active people). Best-effort: never blocks or fails the request.
   */
  private async touchLastActive(userId: string) {
    try {
      if (!(await this.redis.setIfAbsent(`active:${userId}`, 3600))) return;
      await this.userModel
        .updateOne({ _id: userId }, { lastActiveAt: new Date() })
        .exec();
    } catch {
      // Redis or Mongo hiccup — activity tracking is not worth a failed request.
    }
  }
}

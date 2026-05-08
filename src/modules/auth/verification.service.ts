import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes, randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { User } from '../../database/schemas/user/user.schema';
import {
  VerificationToken,
  VerificationTokenType,
} from '../../database/schemas/verification/verification-token.schema';
import { MailerService } from '../mailer/mailer.service';
import { ENV } from '../../config';

const OTP_TTL_MINUTES: Record<VerificationTokenType, number> = {
  [VerificationTokenType.EMAIL_VERIFY]: 10,
  [VerificationTokenType.PASSWORD_RESET]: 30,
  [VerificationTokenType.ACCOUNT_DELETE]: 15,
  [VerificationTokenType.PASSWORD_VERIFY]: 5,
};

const MAX_ATTEMPTS = 5;

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(VerificationToken.name)
    private readonly tokenModel: Model<VerificationToken>,
    private readonly mailerService: MailerService,
  ) {}

  // ----- Email verification -----
  async sendEmailVerificationOtp(email: string): Promise<{ sent: boolean }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.userModel.findOne({ email: normalized });
    if (!user) {
      // Do not leak whether the user exists.
      return { sent: true };
    }
    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    const otp = generateOtp();
    await this.storeOtp(user, normalized, VerificationTokenType.EMAIL_VERIFY, otp);
    await this.mailerService.sendVerificationOtp(normalized, otp, user.firstName);
    return { sent: true };
  }

  async verifyEmailOtp(email: string, otp: string): Promise<{ verified: true }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.userModel.findOne({ email: normalized });
    if (!user) throw new NotFoundException('User not found');

    await this.consumeOtp(user, VerificationTokenType.EMAIL_VERIFY, otp);

    user.isEmailVerified = true;
    user.emailVerifiedAt = new Date();
    await user.save();

    return { verified: true };
  }

  // ----- Password reset -----
  async sendPasswordResetEmail(
    email: string,
  ): Promise<{ sent: boolean }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.userModel.findOne({ email: normalized });
    // Always respond identically to prevent enumeration.
    if (!user) return { sent: true };

    const otp = generateOtp();
    const token = randomBytes(32).toString('hex');
    await this.invalidateExisting(user.id, VerificationTokenType.PASSWORD_RESET);
    await this.tokenModel.create({
      user: new Types.ObjectId(user.id),
      email: normalized,
      type: VerificationTokenType.PASSWORD_RESET,
      otp: await bcrypt.hash(otp, 10),
      token,
      expiresAt: minutesFromNow(
        OTP_TTL_MINUTES[VerificationTokenType.PASSWORD_RESET],
      ),
    });

    const resetUrl = `${ENV.FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(normalized)}`;
    await this.mailerService.sendPasswordResetLink(normalized, resetUrl, otp);
    return { sent: true };
  }

  async resetPassword(args: {
    email: string;
    otp?: string;
    token?: string;
    newPassword: string;
  }): Promise<{ reset: true }> {
    const normalized = args.email.trim().toLowerCase();
    const user = await this.userModel
      .findOne({ email: normalized })
      .select('+password');
    if (!user) throw new NotFoundException('User not found');

    const record = await this.tokenModel.findOne({
      user: new Types.ObjectId(user.id),
      type: VerificationTokenType.PASSWORD_RESET,
      used: false,
    }).sort({ createdAt: -1 });

    if (!record) throw new BadRequestException('Invalid or expired link');
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('Reset link has expired');
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts. Request a new link.');
    }

    let valid = false;
    if (args.token && record.token && safeEqual(record.token, args.token)) {
      valid = true;
    } else if (args.otp && record.otp) {
      valid = await bcrypt.compare(args.otp, record.otp);
    }

    if (!valid) {
      record.attempts += 1;
      await record.save();
      throw new BadRequestException('Invalid code or token');
    }

    user.password = args.newPassword; // pre-save hook hashes
    await user.save();

    record.used = true;
    await record.save();

    await this.mailerService.sendPasswordChangedNotice(normalized).catch(() => {});
    return { reset: true };
  }

  // ----- In-app password verify (re-auth before sensitive actions) -----
  async verifyPassword(userId: string, password: string): Promise<{ valid: true }> {
    const user = await this.userModel.findById(userId).select('+password');
    if (!user) throw new NotFoundException('User not found');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Incorrect password');
    return { valid: true };
  }

  // ----- Account deletion -----
  async sendAccountDeletionOtp(userId: string): Promise<{ sent: true }> {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const otp = generateOtp();
    await this.storeOtp(
      user,
      user.email,
      VerificationTokenType.ACCOUNT_DELETE,
      otp,
    );
    await this.mailerService.sendAccountDeletionOtp(user.email, otp);
    return { sent: true };
  }

  async confirmAccountDeletion(
    userId: string,
    otp: string,
    password: string,
  ): Promise<{ deleted: true }> {
    const user = await this.userModel.findById(userId).select('+password');
    if (!user) throw new NotFoundException('User not found');

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Incorrect password');

    await this.consumeOtp(user, VerificationTokenType.ACCOUNT_DELETE, otp);

    const email = user.email;
    await this.tokenModel.deleteMany({ user: new Types.ObjectId(user.id) });
    await this.userModel.findByIdAndDelete(user.id);

    await this.mailerService.sendAccountDeletedNotice(email).catch(() => {});
    return { deleted: true };
  }

  // ----- Helpers -----
  private async storeOtp(
    user: User,
    email: string,
    type: VerificationTokenType,
    otp: string,
  ) {
    await this.invalidateExisting(user.id, type);
    await this.tokenModel.create({
      user: new Types.ObjectId(user.id),
      email,
      type,
      otp: await bcrypt.hash(otp, 10),
      expiresAt: minutesFromNow(OTP_TTL_MINUTES[type]),
    });
  }

  private async invalidateExisting(
    userId: string,
    type: VerificationTokenType,
  ) {
    await this.tokenModel.updateMany(
      { user: new Types.ObjectId(userId), type, used: false },
      { used: true },
    );
  }

  private async consumeOtp(
    user: User,
    type: VerificationTokenType,
    otp: string,
  ): Promise<void> {
    if (!otp || otp.length < 4) {
      throw new BadRequestException('Invalid code');
    }

    const record = await this.tokenModel
      .findOne({
        user: new Types.ObjectId(user.id),
        type,
        used: false,
      })
      .sort({ createdAt: -1 });

    if (!record) throw new BadRequestException('No active verification code');
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('Verification code has expired');
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts. Request a new code.');
    }
    if (!record.otp) {
      throw new BadRequestException('Invalid code');
    }

    const ok = await bcrypt.compare(otp, record.otp);
    if (!ok) {
      record.attempts += 1;
      await record.save();
      throw new BadRequestException('Invalid code');
    }

    record.used = true;
    await record.save();
  }
}

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

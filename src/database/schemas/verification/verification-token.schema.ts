import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum VerificationTokenType {
  EMAIL_VERIFY = 'email_verify',
  PASSWORD_RESET = 'password_reset',
  ACCOUNT_DELETE = 'account_delete',
  PASSWORD_VERIFY = 'password_verify',
}

@Schema({ timestamps: true, collection: 'verification_tokens' })
export class VerificationToken extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ required: true, lowercase: true, trim: true, index: true })
  email: string;

  @Prop({ type: String, enum: VerificationTokenType, required: true, index: true })
  type: VerificationTokenType;

  // 6-digit OTP for email/delete flows. Stored as string (preserves leading zeros).
  @Prop()
  otp?: string;

  // Long opaque token for password-reset deep links.
  @Prop({ index: true })
  token?: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ default: false })
  used: boolean;
}

export const VerificationTokenSchema =
  SchemaFactory.createForClass(VerificationToken);

VerificationTokenSchema.index({ user: 1, type: 1, used: 1 });
// TTL: Mongo auto-removes documents after expiresAt.
VerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

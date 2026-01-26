import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import * as bcrypt from 'bcrypt';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

@Schema({ timestamps: true, collection: 'users' })
export class User extends Document {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop()
  firstName?: string;

  @Prop()
  lastName?: string;

  @Prop({ type: String, enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isBanned: boolean;

  @Prop()
  bannedAt?: Date;

  @Prop({ select: false })
  refreshToken?: string;

  // Stripe Connect
  @Prop()
  stripeConnectAccountId?: string; // Stripe Connected Account ID

  @Prop({ default: false })
  stripeOnboardingComplete: boolean; // Has completed Stripe onboarding

  @Prop()
  stripeAccountType?: string; // express | standard | custom

  // Social counts
  @Prop({ default: 0 })
  followerCount: number;

  @Prop({ default: 0 })
  followingCount: number;

  @Prop({ default: 0 })
  videoCount: number;

  createdAt: Date;
  updatedAt: Date;
  @Prop({ unique: true, sparse: true, lowercase: true, trim: true })
  username?: string;

  @Prop()
  profileImage?: string; // S3 / CDN URL

  @Prop()
  bio?: string;

  @Prop()
  gender?: string;

  async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password);
  }
}

export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.set('autoIndex', true);

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Add method to validate password
UserSchema.methods.validatePassword = async function (
  password: string,
): Promise<boolean> {
  return bcrypt.compare(password, this.password);
};

// Remove password and refreshToken from JSON response
UserSchema.set('toJSON', {
  transform: (_doc, ret) => {
    const { password, refreshToken, __v, ...rest } = ret;
    return rest;
  },
});

// Production-critical indexes for performance
UserSchema.index({ email: 1, isActive: 1 }); // Auth queries
UserSchema.index({ stripeConnectAccountId: 1, stripeOnboardingComplete: 1 }); // Payout eligibility
UserSchema.index({ role: 1, isActive: 1 }); // Admin queries
UserSchema.index({ isBanned: 1 }); // Security queries
UserSchema.index({ createdAt: -1 }); // Recent users
UserSchema.index({ username: 1 });

// 🔍 TEXT SEARCH INDEX (FOR USER SEARCH)
UserSchema.index(
  {
    firstName: 'text',
    lastName: 'text',
    email: 'text',
  },
  {
    weights: {
      firstName: 3,
      lastName: 3,
      email: 1,
    },
    name: 'UserTextSearch',
  },
);

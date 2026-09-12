import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

export enum AuthProvider {
  PASSWORD = 'password',
  GOOGLE = 'google',
}

@Schema({ timestamps: true, collection: 'users' })
export class User extends Document {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  // Optional: an account created through Google has no password until the user
  // sets one via the forgot-password flow.
  @Prop({ select: false })
  password?: string;

  // Google's `sub` claim. Sparse so the unique index ignores password-only users.
  @Prop({ index: true, sparse: true, unique: true })
  googleId?: string;

  @Prop({ type: [String], enum: AuthProvider, default: [AuthProvider.PASSWORD] })
  authProviders: AuthProvider[];

  @Prop()
  firstName?: string;

  @Prop({ default: null })
  usernameUpdatedAt?: Date;

  @Prop()
  lastName?: string;

  @Prop({ type: String, enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isEmailVerified: boolean;

  @Prop()
  emailVerifiedAt?: Date;

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
  dob?: Date;

  @Prop()
  gender?: string;

  // Moderation: users this user has blocked (their content is hidden)
  @Prop({ type: [Types.ObjectId], ref: 'User', default: [] })
  blockedUsers: Types.ObjectId[];

  // App Store compliance: timestamp the user accepted the EULA / community guidelines
  @Prop()
  eulaAcceptedAt?: Date;

  // Virtual currency used to promote videos (bought via IAP; NOT cash).
  @Prop({ default: 0, min: 0 })
  coinBalance: number;

  async validatePassword(password: string): Promise<boolean> {
    if (!this.password) return false;
    return bcrypt.compare(password, this.password);
  }
}

export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.set('autoIndex', true);

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();

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
  if (!this.password) return false;
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
// username is already indexed by @Prop({ unique, sparse }) — a plain index here
// declares the same key a second time, and without the uniqueness constraint.

// 🔍 TEXT SEARCH INDEX (FOR USER SEARCH)
UserSchema.index(
  {
    firstName: 'text',
    lastName: 'text',
    email: 'text',
    username: 'text',

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

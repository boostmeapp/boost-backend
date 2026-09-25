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

  // Call-specific moderation, separate from a full ban: the user keeps the app
  // but cannot place calls.
  @Prop({ default: false })
  callingRestricted: boolean;

  // Set when this user's app fetches a calling token — proof they run a build
  // that can answer. Callers get "needs to update" instead of a silent ring.
  @Prop()
  callingCapableAt?: Date;

  // Who may call this user: 'everyone' | 'mutual_follows' | 'nobody'.
  @Prop({ type: String, enum: ['everyone', 'mutual_follows', 'nobody'], default: 'mutual_follows' })
  callPrivacy: 'everyone' | 'mutual_follows' | 'nobody';

  // Missed calls after this count toward the missed-call badge.
  @Prop()
  callsSeenAt?: Date;

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
  // The display name (see display-name.util). Deliberately NOT unique for now.
  @Prop({ index: true, sparse: true, lowercase: true, trim: true })
  username?: string;

  @Prop()
  profileImage?: string; // S3 / CDN URL

  @Prop()
  coverImage?: string; // Optional profile cover/banner — S3 / CDN URL

  @Prop()
  bio?: string;

  // Master push switch. The queue worker skips recipients who turn this off.
  @Prop({ default: true })
  notificationEnabled: boolean;

  @Prop({ trim: true })
  website?: string;

  @Prop()
  dob?: Date;

  @Prop()
  gender?: string;

  // Last authenticated request, written at most hourly. Boost reach counts
  // only people who actually open the app.
  @Prop({ index: true })
  lastActiveAt?: Date;

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
// username is already indexed by @Prop({ index, sparse }) — a plain index here
// would declare the same key a second time.

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

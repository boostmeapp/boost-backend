import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

import { DevicePlatform } from '../../../modules/notification/notification.constants';

/**
 * An FCM registration token for one install of the app.
 *
 * BOE hangs `fcmToken` off its Session model. Boostra has no session
 * collection — auth is a refresh token on the user — so tokens live here
 * instead. One row per device, keyed by the token itself, which is what FCM
 * guarantees is unique and what lets a token that migrates between accounts be
 * reassigned rather than duplicated.
 */
@Schema({ timestamps: true, collection: 'device_tokens' })
export class DeviceToken extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ required: true, unique: true, trim: true })
  token: string;

  @Prop({
    type: String,
    enum: Object.values(DevicePlatform),
    default: DevicePlatform.Ios,
  })
  platform: DevicePlatform;

  /** Cleared when FCM reports the token is dead, or on logout. */
  @Prop({ default: true, index: true })
  isActive: boolean;

  /** Bumped on every re-registration, so stale tokens can be pruned. */
  @Prop({ default: Date.now })
  lastUsedAt: Date;

  /** Helps debugging when a specific build misbehaves. */
  @Prop()
  appVersion?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);

// The send path: every active token for a user.
DeviceTokenSchema.index({ user: 1, isActive: 1 });

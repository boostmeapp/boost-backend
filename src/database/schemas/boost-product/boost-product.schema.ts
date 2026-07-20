import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Admin-managed catalog of one-time, fixed-duration Boost packages.
 *
 * Prices themselves live in App Store Connect / Google Play Console (IAP rules);
 * this catalog maps a store product id -> what the Boost does (duration, ranking
 * strength) and controls availability/order in the app.
 */
@Schema({ timestamps: true, collection: 'boost_products' })
export class BoostProduct extends Document {
  // Internal stable key (also used as the app-facing identifier)
  @Prop({ required: true, unique: true, trim: true })
  key: string;

  @Prop({ required: true, trim: true })
  title: string;

  @Prop({ trim: true })
  description?: string;

  // How long the boost stays active after purchase
  @Prop({ required: true, min: 1 })
  durationHours: number;

  // Feed ranking strength while active (higher = shown more)
  @Prop({ required: true, default: 100 })
  boostScore: number;

  // Optional watch-to-earn reward pool funded for this boost (platform-funded)
  @Prop({ default: 0 })
  rewardPoolAmount: number;

  // Store product identifiers (must match the products created in the consoles)
  @Prop({ trim: true })
  iosProductId?: string;

  @Prop({ trim: true })
  androidProductId?: string;

  // Display-only price label (real price is enforced by the stores)
  @Prop({ trim: true })
  priceLabel?: string;

  @Prop({ default: true, index: true })
  isActive: boolean;

  @Prop({ default: 0 })
  sortOrder: number;

  createdAt: Date;
  updatedAt: Date;
}

export const BoostProductSchema = SchemaFactory.createForClass(BoostProduct);
BoostProductSchema.index({ isActive: 1, sortOrder: 1 });

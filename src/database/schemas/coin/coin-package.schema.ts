import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Admin-managed coin top-up packs. Sold via App Store / Google Play IAP.
 * Real price is set in the stores; priceLabel is display-only.
 */
@Schema({ timestamps: true, collection: 'coin_packages' })
export class CoinPackage extends Document {
  @Prop({ required: true, unique: true, trim: true })
  key: string;

  @Prop({ required: true, trim: true })
  title: string;

  // Base coins credited on purchase
  @Prop({ required: true, min: 1 })
  coins: number;

  // Extra bonus coins (marketing)
  @Prop({ default: 0 })
  bonusCoins: number;

  @Prop({ trim: true })
  iosProductId?: string;

  @Prop({ trim: true })
  androidProductId?: string;

  @Prop({ trim: true })
  priceLabel?: string;

  @Prop({ default: true, index: true })
  isActive: boolean;

  @Prop({ default: 0 })
  sortOrder: number;

  createdAt: Date;
  updatedAt: Date;
}

export const CoinPackageSchema = SchemaFactory.createForClass(CoinPackage);
CoinPackageSchema.index({ isActive: 1, sortOrder: 1 });

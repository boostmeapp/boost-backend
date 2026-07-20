import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum CoinTxnType {
  PURCHASE = 'purchase', // bought coins via IAP (+)
  SPEND = 'spend', // spent coins promoting a video (-)
  REFUND = 'refund', // coins returned (+)
  ADMIN_ADJUST = 'admin_adjust',
}

@Schema({ timestamps: true, collection: 'coin_transactions' })
export class CoinTransaction extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  @Prop({ type: String, enum: CoinTxnType, required: true })
  type: CoinTxnType;

  // Signed coin delta (+credit / -debit)
  @Prop({ required: true })
  coins: number;

  @Prop({ required: true })
  balanceAfter: number;

  @Prop({ trim: true })
  platform?: string; // ios | android for purchases

  // Store transaction id for IAP purchases (idempotency)
  @Prop({ index: true })
  storeTransactionId?: string;

  @Prop({ trim: true })
  description?: string;

  // Reference (e.g. videoId for spend, packageKey for purchase)
  @Prop({ trim: true })
  ref?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const CoinTransactionSchema =
  SchemaFactory.createForClass(CoinTransaction);
CoinTransactionSchema.index({ user: 1, createdAt: -1 });
CoinTransactionSchema.index(
  { storeTransactionId: 1 },
  { unique: true, sparse: true },
);

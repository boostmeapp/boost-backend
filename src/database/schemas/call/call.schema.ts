import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';
import {
  CallEndReason,
  CallStatus,
  CallType,
} from '../../../modules/call/call.constants';

/**
 * Durable record of every call attempt. Stream owns live call state; this is
 * the history, analytics, and anything that must outlive the Stream session.
 */
@Schema({ timestamps: true, collection: 'calls' })
export class Call extends Document {
  /** `<type>:<id>` as used with Stream. Unique — doubles as idempotency protection. */
  @Prop({ type: String, required: true, trim: true })
  streamCallId: string;

  @Prop({ type: String, enum: Object.values(CallType), required: true })
  callType: CallType;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  initiator: Types.ObjectId;

  /** Two entries for 1:1; an array so group calls need no migration. */
  @Prop({
    type: [{ type: Types.ObjectId, ref: 'User' }],
    required: true,
    validate: {
      validator: (v: Types.ObjectId[]) => Array.isArray(v) && v.length >= 2,
      message: 'A call needs at least two participants',
    },
  })
  participants: Types.ObjectId[];

  /** The chat thread the call was started from, if any. */
  @Prop({ type: Types.ObjectId, ref: 'Conversation' })
  conversation?: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(CallStatus),
    default: CallStatus.Ringing,
  })
  status: CallStatus;

  @Prop({ type: Date, required: true, default: Date.now })
  ringStartedAt: Date;

  @Prop({ type: Date })
  answeredAt?: Date;

  @Prop({ type: Date })
  endedAt?: Date;

  /** Denormalised on end so history queries need no arithmetic. */
  @Prop({ type: Number, min: 0 })
  durationSeconds?: number;

  @Prop({ type: String, enum: Object.values(CallEndReason) })
  endedReason?: CallEndReason;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  endedBy?: Types.ObjectId;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
  rejectedBy: Types.ObjectId[];

  /** Reserved for client-reported quality stats (Iteration 11). */
  @Prop({ type: MongooseSchema.Types.Mixed })
  metadata?: Record<string, any>;

  createdAt: Date;
  updatedAt: Date;
}

export const CallSchema = SchemaFactory.createForClass(Call);

CallSchema.plugin(mongoosePaginate as any);

// History: "my calls, newest first".
CallSchema.index({ participants: 1, createdAt: -1 });
// Ring-timeout sweeper: stuck ringing/active calls by age.
CallSchema.index({ status: 1, ringStartedAt: 1 });
// Metrics and the admin list aggregate over a time range.
CallSchema.index({ createdAt: -1 });
// Webhook reconciliation, and rejects duplicate creation.
CallSchema.index({ streamCallId: 1 }, { unique: true });

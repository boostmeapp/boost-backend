import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

export enum MessageType {
  Text = 'text',
  /** A system message recording a call in this thread. */
  Call = 'call',
}

/** Snapshot of the call a `call` message records. */
@Schema({ _id: false })
export class MessageCallInfo {
  @Prop({ type: Types.ObjectId, ref: 'Call', required: true })
  callId: Types.ObjectId;

  @Prop({ type: String, required: true })
  callType: string;

  @Prop({ type: String, required: true })
  status: string;

  @Prop({ type: Number, default: 0 })
  durationSeconds: number;
}

const MessageCallInfoSchema = SchemaFactory.createForClass(MessageCallInfo);

@Schema({ timestamps: true, collection: 'messages' })
export class Message extends Document {
  // Existing rows have no type and read as text.
  @Prop({ type: String, enum: Object.values(MessageType), default: MessageType.Text })
  type: MessageType;

  /** Set only when type is `call`. The sender is the call's initiator. */
  @Prop({ type: MessageCallInfoSchema })
  call?: MessageCallInfo;

  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true })
  conversation: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  sender: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  recipient: Types.ObjectId;

  @Prop({ type: String, default: '' })
  text: string;

  @Prop({ type: String, default: '' })
  image: string;

  @Prop({ type: Boolean, default: false })
  isRead: boolean;

  @Prop({ type: Boolean, default: false })
  isEdited: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

MessageSchema.plugin(mongoosePaginate as any);

MessageSchema.index({ conversation: 1, createdAt: -1 });
MessageSchema.index({ sender: 1, recipient: 1 });

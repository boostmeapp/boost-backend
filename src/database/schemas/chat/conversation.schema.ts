import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

@Schema({ _id: false })
export class LastMessage {
  @Prop({ type: String, default: '' })
  text: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  sender: Types.ObjectId;

  @Prop({ type: Date, default: Date.now })
  createdAt: Date;
}

const LastMessageSchema = SchemaFactory.createForClass(LastMessage);

@Schema({ timestamps: true, collection: 'conversations' })
export class Conversation extends Document {
  @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], required: true })
  participants: Types.ObjectId[];

  @Prop({ type: LastMessageSchema, default: {} })
  lastMessage: LastMessage;

  @Prop({ type: Map, of: Number, default: {} })
  unreadCount: Map<string, number>;

  createdAt: Date;
  updatedAt: Date;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

ConversationSchema.plugin(mongoosePaginate as any);

ConversationSchema.index({ participants: 1 });
ConversationSchema.index({ updatedAt: -1 });

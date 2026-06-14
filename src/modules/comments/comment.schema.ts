import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ timestamps: true, collection: 'comments' })
export class Comment extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Video', required: true, index: true })
  video: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user: Types.ObjectId;

  // Reply system
  @Prop({ type: Types.ObjectId, ref: 'Comment', default: null, index: true })
  parentComment?: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 500 })
  content: string;

  // Stats
  @Prop({ default: 0 })
  likeCount: number;

  // Soft delete (by author / video owner)
  @Prop({ default: false, index: true })
  isDeleted: boolean;

  // Moderation
  @Prop({ default: 0 })
  reportCount: number;

  // true when removed by admin moderation
  @Prop({ default: false, index: true })
  isRemoved: boolean;

  @Prop()
  removedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  removedBy?: Types.ObjectId;
}

export const CommentSchema = SchemaFactory.createForClass(Comment);

// PERFORMANCE INDEXES
CommentSchema.index({ video: 1, createdAt: -1 });
CommentSchema.index({ parentComment: 1, createdAt: -1 });
CommentSchema.index({ user: 1, createdAt: -1 });

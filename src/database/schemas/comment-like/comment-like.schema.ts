import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: true })
export class CommentLike extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId!: MongooseSchema.Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Comment', required: true })
  commentId!: MongooseSchema.Types.ObjectId;
}

export const CommentLikeSchema = SchemaFactory.createForClass(CommentLike);

// One like per user per comment.
CommentLikeSchema.index({ userId: 1, commentId: 1 }, { unique: true });

// Resolving "which of these comments did I like" for a page of comments.
CommentLikeSchema.index({ commentId: 1 });

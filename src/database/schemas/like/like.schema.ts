import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

@Schema({ timestamps: true })
export class Like extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: MongooseSchema.Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Video', required: true })
  videoId: MongooseSchema.Types.ObjectId;
}

export const LikeSchema = SchemaFactory.createForClass(Like);

// Create compound index to ensure one like per user per video
LikeSchema.index({ userId: 1, videoId: 1 }, { unique: true });

// Index for querying likes by video
LikeSchema.index({ videoId: 1 });

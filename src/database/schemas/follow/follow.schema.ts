import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

@Schema({ timestamps: true, collection: 'follows' })
export class Follow extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  follower: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  following: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export const FollowSchema = SchemaFactory.createForClass(Follow);

FollowSchema.plugin(mongoosePaginate as any);

// Prevent duplicate follow
FollowSchema.index(
  { follower: 1, following: 1 },
  { unique: true, background: true }
);

// Optimized queries
FollowSchema.index({ following: 1, createdAt: -1 });
FollowSchema.index({ follower: 1, createdAt: -1 });


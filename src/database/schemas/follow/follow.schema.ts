import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import mongoosePaginate from 'mongoose-paginate-v2';

@Schema({ timestamps: true, collection: 'follows' })
export class Follow extends Document {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  follower: Types.ObjectId; // User who is following

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  following: Types.ObjectId; // User being followed

  createdAt: Date;
  updatedAt: Date;
}

export const FollowSchema = SchemaFactory.createForClass(Follow);

// Add pagination plugin
FollowSchema.plugin(mongoosePaginate as any);

// Compound index for uniqueness and fast lookups
FollowSchema.index({ follower: 1, following: 1 }, { unique: true });

// Index for getting followers of a user
FollowSchema.index({ following: 1, createdAt: -1 });

// Index for getting who a user is following
FollowSchema.index({ follower: 1, createdAt: -1 });

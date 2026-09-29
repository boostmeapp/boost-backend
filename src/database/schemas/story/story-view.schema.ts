import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

/**
 * One person's view of one story. The unique (story, viewer) index is what
 * makes a viewer count once however many times they open it.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'story_views',
})
export class StoryView extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Story', required: true })
  story: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  viewer: Types.ObjectId;

  /** The story's owner, so "who viewed my stories" needs no join. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  owner: Types.ObjectId;

  /** A like always comes from a viewer, so it lives on the view row. */
  @Prop({ default: false })
  liked: boolean;

  @Prop()
  likedAt?: Date;

  createdAt: Date;
}

export const StoryViewSchema = SchemaFactory.createForClass(StoryView);

// Counting once per viewer is a correctness guarantee, so this index is
// built in production too (autoIndex is off there by default).
StoryViewSchema.set('autoIndex', true);

StoryViewSchema.index({ story: 1, viewer: 1 }, { unique: true });
// The viewers list, newest first.
StoryViewSchema.index({ story: 1, createdAt: -1 });
// "Have I seen this?" across a feed of stories.
StoryViewSchema.index({ viewer: 1, story: 1 });

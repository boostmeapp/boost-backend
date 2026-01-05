import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'tags' })
export class Tag extends Document {
  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true })
  name: string; // e.g., "tech", "gaming", "fitness"

  createdAt: Date;
  updatedAt: Date;
}

export const TagSchema = SchemaFactory.createForClass(Tag);

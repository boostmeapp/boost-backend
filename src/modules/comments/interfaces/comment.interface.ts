import { Types } from 'mongoose';

export interface CommentResponse {
  _id: string;
  content: string;
  video: Types.ObjectId;
  parentComment?: Types.ObjectId | null;
  likeCount: number;
  createdAt: Date;
  user: {
    _id: string;
    firstName?: string;
    lastName?: string;
  };
}


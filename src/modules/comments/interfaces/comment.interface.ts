import { Types } from 'mongoose';

export interface CommentResponse {
  _id: string;
  content: string;
  video: Types.ObjectId;
  parentComment?: Types.ObjectId | null;
  likeCount: number;
  isLiked?: boolean;
  isReported?: boolean;
  createdAt: Date;
  user: {
    _id: string;
    // The display name; firstName/lastName are the legacy fallback.
    username?: string;
    firstName?: string;
    lastName?: string;
    profileImage?: string;
  };
}


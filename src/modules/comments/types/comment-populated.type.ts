import { Types } from 'mongoose';

export type CommentWithVideoUser = {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  video: {
    _id: Types.ObjectId;
    user: Types.ObjectId;
  };
  isDeleted: boolean;
};

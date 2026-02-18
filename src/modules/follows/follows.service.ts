import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { PaginateModel } from 'mongoose';
import { Model, Types } from 'mongoose';
import { Follow } from '../../database/schemas/follow/follow.schema';
import { User } from '../../database/schemas/user/user.schema';

@Injectable()
export class FollowsService {
  constructor(
    @InjectModel(Follow.name) private followModel: PaginateModel<Follow>,
    @InjectModel(User.name) private userModel: Model<User>,
  ) { }

  // Follow a user
 async follow(followerId: string, followingId: string) {
  if (followerId === followingId) {
    throw new BadRequestException('You cannot follow yourself');
  }

  const followerObj = new Types.ObjectId(followerId);
  const followingObj = new Types.ObjectId(followingId);

  const userExists = await this.userModel.exists({ _id: followingObj });
  if (!userExists) {
    throw new NotFoundException('User not found');
  }

  const alreadyFollowing = await this.followModel.exists({
    follower: followerObj,
    following: followingObj,
  });

  if (alreadyFollowing) {
    throw new ConflictException('Already following');
  }

  await this.followModel.create({
    follower: followerObj,
    following: followingObj,
  });

  await this.userModel.bulkWrite([
    {
      updateOne: {
        filter: { _id: followerObj },
        update: { $inc: { followingCount: 1 } },
      },
    },
    {
      updateOne: {
        filter: { _id: followingObj },
        update: { $inc: { followerCount: 1 } },
      },
    },
  ]);

  return { message: 'Followed successfully' };
}


  // Unfollow a user
  async unfollow(followerId: string, followingId: string) {
  const followerObj = new Types.ObjectId(followerId);
  const followingObj = new Types.ObjectId(followingId);

  const deleted = await this.followModel.findOneAndDelete({
    follower: followerObj,
    following: followingObj,
  });

  if (!deleted) {
    throw new NotFoundException('You are not following this user');
  }

  await this.userModel.bulkWrite([
    {
      updateOne: {
        filter: { _id: followerObj, followingCount: { $gt: 0 } },
        update: { $inc: { followingCount: -1 } },
      },
    },
    {
      updateOne: {
        filter: { _id: followingObj, followerCount: { $gt: 0 } },
        update: { $inc: { followerCount: -1 } },
      },
    },
  ]);

  return { message: 'Unfollowed successfully' };
}



  // Get list of followers with pagination
 async getFollowers(userId: string, page = 1, limit = 20) {
  return this.followModel.paginate(
    { following: new Types.ObjectId(userId) },
    {
      page,
      limit,
      sort: { createdAt: -1 },
      populate: {
        path: 'follower',
        select: '_id firstName lastName profileImage followerCount followingCount',
      },
      lean: true,
    },
  );
}


  // Get list of users being followed with pagination
async getFollowing(userId: string, page = 1, limit = 20) {
  return this.followModel.paginate(
    { follower: new Types.ObjectId(userId) },
    {
      page,
      limit,
      sort: { createdAt: -1 },
      populate: {
        path: 'following',
        select: '_id firstName lastName profileImage followerCount followingCount',
      },
      lean: true,
    },
  );
}


  // Check if user A is following user B
  async isFollowing(follower: string, following: string): Promise<boolean> {
    const follow = await this.followModel
      .exists({
        follower: new Types.ObjectId(follower),
        following: new Types.ObjectId(following),
      })
      .exec();
    return !!follow;
  }

  // Get list of user IDs that a user is following (for feed)
  async getFollowingIds(userId: string): Promise<string[]> {
    const follows = await this.followModel
      .find({ follower: userId })
      .select('following')
      .lean()
      .exec();

    return follows.map((f) => f.following.toString());
  }
}

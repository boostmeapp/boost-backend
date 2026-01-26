import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { PaginateModel } from 'mongoose';
import { Model } from 'mongoose';
import { Follow } from '../../database/schemas/follow/follow.schema';
import { User } from '../../database/schemas/user/user.schema';

@Injectable()
export class FollowsService {
  constructor(
    @InjectModel(Follow.name) private followModel: PaginateModel<Follow>,
    @InjectModel(User.name) private userModel: Model<User>,
  ) {}

  // Follow a user
  async follow(follower: string, following: string): Promise<Follow> {
    if (follower === following) {
      throw new BadRequestException('You cannot follow yourself');
    }

    // Check if already following
    const existing = await this.followModel
      .findOne({ follower, following })
      .exec();

    if (existing) {
      throw new ConflictException('You are already following this user');
    }

    // Check if user exists
    const userToFollow = await this.userModel.findById(following).exec();
    if (!userToFollow) {
      throw new NotFoundException('User to follow not found');
    }

    // Create follow relationship
   const followDoc = await this.followModel.findOneAndUpdate(
  { follower, following },
  { follower, following },
  { upsert: true, new: true },
);


    // Update follower/following counts
    await Promise.all([
      this.userModel.findByIdAndUpdate(follower, {
        $inc: { followingCount: 1 },
      }),
      this.userModel.findByIdAndUpdate(following, {
        $inc: { followerCount: 1 },
      }),
    ]);

    return followDoc;
  }

  // Unfollow a user
 async unfollow(follower: string, following: string): Promise<void> {
  const result = await this.followModel
    .findOneAndDelete({ follower, following })
    .exec();

  if (!result) {
    throw new NotFoundException('You are not following this user');
  }

  // ✅ SAFE decrement (negative count se bachaata hai)
  await Promise.all([
    this.userModel.updateOne(
      { _id: follower, followingCount: { $gt: 0 } },
      { $inc: { followingCount: -1 } },
    ),
    this.userModel.updateOne(
      { _id: following, followerCount: { $gt: 0 } },
      { $inc: { followerCount: -1 } },
    ),
  ]);
}


  // Get list of followers with pagination
  async getFollowers(userId: string, page: number = 1, limit: number = 20) {
    return await this.followModel.paginate(
      { following: userId },
      {
        page,
        limit,
        sort: { createdAt: -1 },
        populate: {
          path: 'follower',
          select: 'email firstName lastName followerCount followingCount',
        },
      },
    );
  }

  // Get list of users being followed with pagination
  async getFollowing(userId: string, page: number = 1, limit: number = 20) {
    return await this.followModel.paginate(
      { follower: userId },
      {
        page,
        limit,
        sort: { createdAt: -1 },
        populate: {
          path: 'following',
          select: 'email firstName lastName followerCount followingCount',
        },
      },
    );
  }

  // Check if user A is following user B
  async isFollowing(follower: string, following: string): Promise<boolean> {
    const follow = await this.followModel
      .exists({ follower, following })
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

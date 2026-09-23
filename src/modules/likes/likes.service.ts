import { Injectable } from '@nestjs/common';
import { BoostEngagementService } from '../boost-campaigns/boost-engagement.service';
import { displayName } from '../../common/utils/display-name.util';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Like } from '../../database/schemas/like/like.schema';
import { Video } from '../../database/schemas/video/video.schema';
import { User } from '../../database/schemas/user/user.schema';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/notification.constants';

@Injectable()
export class LikesService {
  constructor(
    @InjectModel(Like.name) private likeModel: Model<Like>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(User.name) private userModel: Model<User>,
    private readonly notificationService: NotificationService,
    private readonly boostEngagement: BoostEngagementService,
  ) {}

  /** Fire-and-forget: notify the video owner that someone liked their post. */
  private async notifyOwner(actorId: string, videoId: string) {
    const video = await this.videoModel
      .findById(videoId)
      .select('user title')
      .lean();

    if (!video?.user) return;

    const actor = await this.userModel
      .findById(actorId)
      .select('firstName lastName username')
      .lean();

    const actorName = displayName(actor);

    void this.notificationService.notify({
      users: String(video.user),
      actor: actorId,
      type: NotificationType.Like,
      title: actorName,
      body: `${actorName} liked your post`,
      metadata: { videoId, title: video.title ?? '' },
    });
  }

  async toggleLike(
    userId: string,
    videoId: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    const userObjectId = new Types.ObjectId(userId);
    const videoObjectId = new Types.ObjectId(videoId);

    const existingLike = await this.likeModel.findOne({
      userId: userObjectId,
      videoId: videoObjectId,
    });

    if (existingLike) {
      // Unlike: remove the like
      await this.likeModel.deleteOne({ _id: existingLike._id });
      const likeCount = await this.likeModel.countDocuments({
        videoId: videoObjectId,
      });
      return { liked: false, likeCount };
    } else {
      // Like: create new like
      await this.likeModel.create({
        userId: userObjectId,
        videoId: videoObjectId,
      });
      const likeCount = await this.likeModel.countDocuments({
        videoId: videoObjectId,
      });

      // Only on the like, never the unlike.
      void this.notifyOwner(userId, videoId);
      void this.boostEngagement.onVideoEngagement(userId, videoId, 'likes');

      return { liked: true, likeCount };
    }
  }

  async hasUserLikedVideo(userId: string, videoId: string): Promise<boolean> {
    const like = await this.likeModel.findOne({
      userId: new Types.ObjectId(userId),
      videoId: new Types.ObjectId(videoId),
    });
    return !!like;
  }

  async hasUserLikedVideos(
    userId: string,
    videoIds: string[],
  ): Promise<Map<string, boolean>> {
    const videoObjectIds = videoIds.map((id) => new Types.ObjectId(id));
    const likes = await this.likeModel.find({
      userId: new Types.ObjectId(userId),
      videoId: { $in: videoObjectIds },
    });

    const likedMap = new Map<string, boolean>();
    videoIds.forEach((id) => likedMap.set(id, false));
    likes.forEach((like) => {
      likedMap.set(like.videoId.toString(), true);
    });

    return likedMap;
  }

  async getLikeCount(videoId: string): Promise<number> {
    return this.likeModel.countDocuments({
      videoId: new Types.ObjectId(videoId),
    });
  }

  async getLikeCounts(videoIds: string[]): Promise<Map<string, number>> {
    const videoObjectIds = videoIds.map((id) => new Types.ObjectId(id));

    const counts = await this.likeModel.aggregate([
      { $match: { videoId: { $in: videoObjectIds } } },
      { $group: { _id: '$videoId', count: { $sum: 1 } } },
    ]);

    const countMap = new Map<string, number>();
    videoIds.forEach((id) => countMap.set(id, 0));
    counts.forEach((item) => {
      countMap.set(item._id.toString(), item.count);
    });

    return countMap;
  }
}

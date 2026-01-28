import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Video, User } from 'src/database/schemas';

@Injectable()
export class SearchService {
  constructor(
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(User.name) private userModel: Model<User>,
  ) { }

  async searchVideos(query: string, page = 1, limit = 20) {
    return this.videoModel
      .find(
        {
          $text: { $search: query },
          processingStatus: 'ready',
        },
        {
          score: { $meta: 'textScore' },
        },
      )
      .sort({ score: { $meta: 'textScore' }, boostScore: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
  }

  async searchUsers(query: string, page = 1, limit = 20) {
    return this.userModel
      .find(
        {
          $text: { $search: query },
          isActive: true,
          isBanned: false,
        },
        {
          score: { $meta: 'textScore' },
        },
      )
      .sort({ score: { $meta: 'textScore' } })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('firstName lastName followerCount profileImage username')
      .lean();
  }

 async globalSearch(query: string, page = 1, limit = 12) {
  const skip = (page - 1) * limit;

  const [users, videos] = await Promise.all([
    // 👤 USERS
    this.userModel
      .find(
        {
          $text: { $search: query },
          isActive: true,
          isBanned: false,
        },
        { score: { $meta: 'textScore' } },
      )
      .sort({ score: { $meta: 'textScore' }, followerCount: -1 })
      .limit(10)
      .select('firstName lastName followerCount profileImage username')
      .lean(),

    // 🎥 VIDEOS (caption / tags / title)
    this.videoModel
      .find(
        {
          $text: { $search: query },
          processingStatus: 'ready',
        },
        { score: { $meta: 'textScore' } },
      )
      .sort({
        score: { $meta: 'textScore' },
        boostScore: -1,
        viewCount: -1,
      })
      .skip(skip)
      .limit(limit)
      .populate('user', 'firstName lastName profileImage username')
      .select(`
        title
        caption
        tags
        thumbnailUrl
        rawVideoKey
        duration
        viewCount
        likeCount
        commentCount
        user
      `)
      .lean(),
  ]);

  return {
    users,
    videos,
  };
}


}

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { MailerService } from '../mailer/mailer.service';
import { User } from '../../database/schemas/user/user.schema';
import { Video } from '../../database/schemas/video/video.schema';
import { Comment } from '../comments/comment.schema';
import { Follow } from '../../database/schemas/follow/follow.schema';
import { Like } from '../../database/schemas/like/like.schema';
import { Transaction } from '../../database/schemas/transaction/transaction.schema';
import { buildExportPdf } from './export-pdf.builder';

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    private readonly mailerService: MailerService,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Video.name) private videoModel: Model<Video>,
    @InjectModel(Comment.name) private commentModel: Model<Comment>,
    @InjectModel(Follow.name) private followModel: Model<Follow>,
    @InjectModel(Like.name) private likeModel: Model<Like>,
    @InjectModel(Transaction.name) private transactionModel: Model<Transaction>,
  ) {}

  async emailExport(user: User) {
    const userId = user._id.toString();
    const objectId = new Types.ObjectId(userId);

    const [profile, videos, comments, following, followers, likes, transactions] =
      await Promise.all([
        this.userModel
          .findById(objectId)
          .select('-password -refreshToken -__v')
          .lean(),
        this.videoModel
          .find({ user: objectId })
          .select('title description caption tags duration viewCount likeCount commentCount createdAt')
          .lean(),
        this.commentModel
          .find({ user: objectId, isDeleted: false })
          .select('content video createdAt')
          .lean(),
        this.followModel.countDocuments({ follower: objectId }),
        this.followModel.countDocuments({ following: objectId }),
        this.likeModel.find({ userId: objectId }).select('videoId createdAt').lean(),
        this.transactionModel
          .find({ user: objectId })
          .select('type amount status createdAt')
          .lean(),
      ]);

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();

    const pdf = await buildExportPdf({
      name: name || user.email,
      profile,
      stats: { following, followers },
      videos,
      comments,
      likes,
      transactions,
    });

    const delivered = await this.mailerService.sendDataExport(
      user.email,
      pdf,
      name || undefined,
    );

    if (!delivered) {
      this.logger.error(`[EXPORT] Could not deliver export for ${user.email}`);
      throw new InternalServerErrorException(
        'We could not send your data export right now. Please try again later.',
      );
    }

    return {
      success: true,
      message: `Your data export has been emailed to ${user.email}.`,
    };
  }
}


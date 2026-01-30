import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User } from '../../database/schemas/user/user.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { FollowsService } from '../follows/follows.service';
import { Video } from '../../database/schemas/video/video.schema';
import { Follow } from 'src/database/schemas/follow/follow.schema';


@Injectable()
export class UsersService {
constructor(
  @InjectModel(User.name) private userModel: Model<User>,
  @InjectModel(Video.name) private videoModel: Model<Video>,
  @InjectModel(Follow.name) private followModel: Model<Follow>,
) {}

  private static readonly USERNAME_CHANGE_DAYS = 60;

async create(createUserDto: CreateUserDto): Promise<User> {
  const existingUser = await this.userModel.findOne({
    email: createUserDto.email.trim().toLowerCase(),
  });

  if (existingUser) {
    throw new ConflictException('User with this email already exists');
  }

  const user = new this.userModel({
    ...createUserDto,
    email: createUserDto.email.trim().toLowerCase(),
  });

  return user.save(); // 🔥 password schema khud hash karega
}



  async findAll(): Promise<User[]> {
    return this.userModel.find().exec();
  }
async getProfile(viewerId: string | null, profileUserId: string) {

  const profileObjectId = new Types.ObjectId(profileUserId);
  const viewerObjectId = viewerId ? new Types.ObjectId(viewerId) : null;

  // 1️⃣ User Profile Info
  const user = await this.userModel.findById(profileObjectId)
    .select("firstName lastName username profileImage followerCount followingCount videoCount")
    .lean();

  if (!user) throw new NotFoundException("User not found");

  // 2️⃣ Stats (Real Time Counts)
  const [followers, following, videos] = await Promise.all([
    this.followModel.countDocuments({ following: profileObjectId }),
    this.followModel.countDocuments({ follower: profileObjectId }),
    this.videoModel.countDocuments({
      user: profileObjectId,
      processingStatus: "ready"
    })
  ]);

  // 3️⃣ Viewer Relationship
  let isFollowing = false;

  if (viewerObjectId) {
    const follow = await this.followModel.findOne({
      follower: viewerObjectId,
      following: profileObjectId
    });

    isFollowing = !!follow;
  }

  // 4️⃣ First Page Grid Videos
  const gridVideos = await this.videoModel.find({
    user: profileObjectId,
    processingStatus: "ready"
  })
  .sort({ createdAt: -1 })
  .limit(12)
  .select("thumbnailUrl duration viewCount likeCount")
  .lean();

  return {
    user,
    stats: {
      followers,
      following,
      videos
    },
    isFollowing,
    gridVideos
  };
}

  async findOne(id: string): Promise<User> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }

async findByEmail(email: string): Promise<User | null> {
  return this.userModel
    .findOne({ email: email.trim().toLowerCase() })
    .select('+password +isActive')
    .exec();
}


  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.userModel
      .findByIdAndUpdate(
        id,
        updateUserDto,
        {
          new: true,
          select:
            'email firstName lastName username profileImage bio gender followerCount followingCount videoCount role',
        },
      )
      .exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return user;
  }
  async updateMe(userId: string, dto: UpdateUserDto) {
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    // ❌ Email change blocked
    if ((dto as any).email) {
      throw new ForbiddenException(
        'Email cannot be changed. Contact support.',
      );
    }

    // ✅ Username change rule
    if (dto.username && dto.username !== user.username) {
      if (user.usernameUpdatedAt) {
        const daysPassed =
          (Date.now() - user.usernameUpdatedAt.getTime()) /
          (1000 * 60 * 60 * 24);

        if (daysPassed < UsersService.USERNAME_CHANGE_DAYS) {
          throw new ForbiddenException(
            `Username can be changed once every ${UsersService.USERNAME_CHANGE_DAYS} days`,
          );
        }
      }

      user.username = dto.username;
      user.usernameUpdatedAt = new Date();
    }

    Object.assign(user, dto);
    await user.save();

    return user;
  }



  async remove(id: string): Promise<void> {
    const result = await this.userModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
  }



  async changePassword(
    userId: string,
    changePasswordDto: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.userModel
      .findById(userId)
      .select('+password')
      .exec();

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const isPasswordValid = await bcrypt.compare(
      changePasswordDto.currentPassword,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(changePasswordDto.newPassword, 10);
    user.password = hashedPassword;
    await user.save();
  }
}

import {
  Body,
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { PresignUploadDto, UploadType } from './dto';
import { UsersService } from '../users/users.service';

@Controller('upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly usersService: UsersService, // ✅ ADD
  ) {}

  // Direct-to-S3 for video: the API authorises and bounds, but never sees a media byte.
  @Post('presign')
  async presign(@CurrentUser() user: User, @Body() dto: PresignUploadDto) {
    const presigned = await this.uploadService.generatePresignedPost(
      user.id,
      dto,
    );
    return { success: true, ...presigned };
  }

  // ✅ SINGLE FINAL ENDPOINT FOR PROFILE IMAGES
  @Post('profile-image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(), // ✅ REQUIRED
      limits: { fileSize: 1 * 1024 * 1024 }, // 1MB
      fileFilter: (_, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(
            new BadRequestException('Only image files allowed'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async uploadProfileImage(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Image file is required');
    }

    // 1️⃣ Upload to S3
    const { url } = await this.uploadService.uploadFile(
      user.id,
      UploadType.PROFILE_IMAGE,
      file,
    );

    // 2️⃣ SAVE URL DIRECTLY IN USER TABLE ✅
    const updatedUser = await this.usersService.update(user.id, {
      profileImage: url,
    });

    return {
      success: true,
      url,
      user: updatedUser,
    };
  }

  // ✅ DEDICATED ENDPOINT FOR CHAT / GENERAL IMAGES
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 1 * 1024 * 1024 }, // 1MB
      fileFilter: (_, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(
            new BadRequestException('Only image files allowed'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async uploadChatImage(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Image file is required');
    }

    const { url, key } = await this.uploadService.uploadFile(
      user.id,
      UploadType.CHAT_IMAGE,
      file,
    );

    return {
      success: true,
      url,
      key,
    };
  }
  // ✅ VIDEO COVER THUMBNAILS — image mimetypes, keyed under thumbnails/
  @Post('thumbnail')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 1 * 1024 * 1024 }, // 1MB — matches MAX_IMAGE_UPLOAD_SIZE
      fileFilter: (_, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          return cb(
            new BadRequestException('Only image files allowed'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async uploadThumbnail(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Image file is required');
    }

    const { url, key } = await this.uploadService.uploadFile(
      user.id,
      UploadType.THUMBNAIL,
      file,
    );

    return { success: true, url, key };
  }

}

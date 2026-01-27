import {
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
import { UploadType } from './dto';
import { UsersService } from '../users/users.service';

@Controller('upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(
    private readonly uploadService: UploadService,
    private readonly usersService: UsersService, // ✅ ADD
  ) {}

  // ✅ SINGLE FINAL ENDPOINT
  @Post('profile-image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(), // ✅ REQUIRED
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
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

    // 3️⃣ RETURN USER (NO EXTRA API)
    return updatedUser;
  }
  @Post('video')
@UseInterceptors(
  FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
    fileFilter: (_, file, cb) => {
      if (!file.mimetype.startsWith('video/')) {
        return cb(
          new BadRequestException('Only video files allowed'),
          false,
        );
      }
      cb(null, true);
    },
  }),
)
async uploadVideo(
  @CurrentUser() user: User,
  @UploadedFile() file: Express.Multer.File,
) {
  if (!file?.buffer) {
    throw new BadRequestException('Video file is required');
  }

  return this.uploadService.uploadFile(
    user.id,
    UploadType.VIDEO,
    file,
  );
}

}

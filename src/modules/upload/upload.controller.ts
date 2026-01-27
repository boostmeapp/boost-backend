import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadService } from './upload.service';
import { DirectUploadDto, UploadType } from './dto';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';

@Controller('upload')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(), // ✅ REQUIRED FOR S3
      limits: {
        fileSize: 500 * 1024 * 1024, // 500MB
      },
      fileFilter: (_, file, cb) => {
        if (
          !file.mimetype.startsWith('image/') &&
          !file.mimetype.startsWith('video/')
        ) {
          return cb(
            new BadRequestException('Invalid file type'),
            false,
          );
        }
        cb(null, true);
      },
    }),
  )
  async directUpload(
    @CurrentUser() user: User,
    @Body() dto: DirectUploadDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('File buffer missing');
    }

    return this.uploadService.uploadFile(user.id, dto.type, file);
  }

  @Get('signed-url/:key')
  async getSignedUrl(@Param('key') key: string) {
    return this.uploadService.generateDownloadUrl(key);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFile(@Param('key') key: string) {
    await this.uploadService.deleteFile(key);
    return { message: 'File deleted successfully' };
  }
  @Post('profile-image')
@UseGuards(JwtAuthGuard)
async getProfileImageUploadUrl(
  @CurrentUser() user: User,
  @Body() body: { fileName: string; fileSize: number },
) {
  return this.uploadService.generateProfileImageUploadUrl(
    user.id,
    body.fileName,
    body.fileSize,
  );
}
@Post('profile-image/multipart')
@UseGuards(JwtAuthGuard)
@UseInterceptors(FileInterceptor('file'))
async uploadProfileImage(
  @CurrentUser() user: User,
  @UploadedFile() file: Express.Multer.File,
) {
  if (!file) {
    throw new BadRequestException('File is required');
  }

  return this.uploadService.uploadFile(
    user.id,
    UploadType.PROFILE_IMAGE,
    file,
  );
}

}

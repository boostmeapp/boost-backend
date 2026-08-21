import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { VideoService } from './video.service';
import { CreateVideoDto, UpdateVideoDto } from './dto';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';


@Controller('videos')
export class VideoController {
  constructor(private readonly videoService: VideoService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: User, @Body() createVideoDto: CreateVideoDto) {
    return this.videoService.create(user.id, createVideoDto);
  }
  // Removed: feed/following and feed/following/cursor — parallel, unused implementations of GET /feed/following.

  @Get('my-videos')
  @UseGuards(JwtAuthGuard)
  async getMyVideos(
    @CurrentUser() user: User,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('processingStatus') processingStatus?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;

    const filters: any = {};
    if (processingStatus) filters.processingStatus = processingStatus;

    return this.videoService.findAll(pageNum, limitNum, { userId: user.id, ...filters }, user.id);
  }

  // Public, but richer for a signed-in viewer (hasLiked + isFollowing).
  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  async findOne(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.videoService.findOne(id, user?.id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() updateVideoDto: UpdateVideoDto,
  ) {
    return this.videoService.update(id, user.id, updateVideoDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    await this.videoService.remove(id, user.id);
  }

  @Post(':id/like')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async toggleLike(@Param('id') id: string, @CurrentUser() user: User) {
    return this.videoService.toggleLike(user.id, id);
  }
}

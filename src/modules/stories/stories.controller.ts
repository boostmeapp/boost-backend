import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { StoriesService } from './stories.service';
import { CreateStoryDto, ReplyToStoryDto, ShareStoryDto } from './dto';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { PaginationDto } from '../follows/dto/pagination.dto';

/**
 * Stories: create one, read the stories of people you follow, and record who
 * watched them. A story is live for 24 hours (see stories.constants) and is
 * never deleted from the database — it only stops being returned.
 */
@Controller('stories')
@UseGuards(JwtAuthGuard)
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  /** Post a story from media already uploaded to S3. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: User, @Body() dto: CreateStoryDto) {
    return this.stories.create(user.id, dto);
  }

  /** Active stories from the people you follow, grouped by author. */
  @Get('feed')
  feed(@CurrentUser() user: User) {
    return this.stories.getFeed(user.id);
  }

  /** Your own live stories. */
  @Get('me')
  mine(@CurrentUser() user: User) {
    return this.stories.getMine(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.stories.findOne(id, user.id);
  }

  /** Mark a story as watched. Counts once per viewer, never for the owner. */
  @Post(':id/view')
  @HttpCode(HttpStatus.OK)
  view(@CurrentUser() user: User, @Param('id') id: string) {
    return this.stories.recordView(id, user.id);
  }

  /** Heart a story, or take the heart back. */
  @Post(':id/like')
  @HttpCode(HttpStatus.OK)
  like(@CurrentUser() user: User, @Param('id') id: string) {
    return this.stories.toggleLike(id, user.id);
  }

  /** Send a story into one or more chats. */
  @Post(':id/share')
  @HttpCode(HttpStatus.CREATED)
  share(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: ShareStoryDto,
  ) {
    return this.stories.share(id, user.id, dto);
  }

  /**
   * Reply to a story. Sends an ordinary chat message to its owner, with the
   * story attached, reusing the existing conversation or starting one.
   */
  @Post(':id/reply')
  @HttpCode(HttpStatus.CREATED)
  reply(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: ReplyToStoryDto,
  ) {
    return this.stories.reply(id, user.id, dto.text);
  }

  /** Who viewed this story. Owner only. */
  @Get(':id/viewers')
  viewers(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query() query: PaginationDto,
  ) {
    return this.stories.getViewers(id, user.id, query.page, query.limit);
  }

  @Delete(':id')
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.stories.remove(id, user.id);
  }
}

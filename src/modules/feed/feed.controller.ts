import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FeedService } from './feed.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { PaginationDto } from '../../common/dto';

@Controller('feed')
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  // ✅ GLOBAL FEED (NO AUTH)
  @Get('global')
  async getGlobalFeed(@Query() query: PaginationDto) {
    return this.feedService.getGlobalFeed(
      query.page,
      query.limit,
    );
  }

  // ✅ FOLLOWING FEED (AUTH REQUIRED)
  @UseGuards(JwtAuthGuard)
  @Get('following')
  async getFollowingFeed(
    @CurrentUser() user: User,
    @Query() query: PaginationDto,
  ) {
    return this.feedService.getFollowingFeed(
      user._id.toString(),   // IMPORTANT use _id not id
      query.page,
      query.limit,
    );
  }
}

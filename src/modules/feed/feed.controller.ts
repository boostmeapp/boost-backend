import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FeedService } from './feed.service';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { FeedQueryDto } from './dto';

@Controller('feed')
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  // Public, but richer for a signed-in viewer (hasLiked + block filtering).
  @UseGuards(OptionalJwtAuthGuard)
  @Get('global')
  async getGlobalFeed(@Query() query: FeedQueryDto, @CurrentUser() user?: User) {
    return this.feedService.getGlobalFeed(query, user?._id?.toString());
  }

  @UseGuards(JwtAuthGuard)
  @Get('following')
  async getFollowingFeed(
    @CurrentUser() user: User,
    @Query() query: FeedQueryDto,
  ) {
    // IMPORTANT use _id not id
    return this.feedService.getFollowingFeed(user._id.toString(), query);
  }
}

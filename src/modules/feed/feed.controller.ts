import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FeedService } from './feed.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { PaginationDto } from '../../common/dto';

@Controller('feed')
@UseGuards(JwtAuthGuard)
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  @Get()
  async getPersonalizedFeed(
    @CurrentUser() user: User,
    @Query() query: PaginationDto,
  ) {
    return this.feedService.getPersonalizedFeed(
      user.id,
      query.page,
      query.limit,
    );
  }
}

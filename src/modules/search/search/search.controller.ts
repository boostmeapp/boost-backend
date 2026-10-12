import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { OptionalJwtAuthGuard } from '../../../common/guards';
import { CurrentUser } from '../../../common/decorators';
import { User } from '../../../database/schemas/user/user.schema';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * People and videos in one paginated list.
   *
   * Open to signed-out viewers; a signed-in one gets their blocked accounts
   * and themselves filtered out, which is why the guard is the optional one.
   *
   *   GET /search?q=alex&page=1&limit=20&type=all|users|videos
   */
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  search(@Query() query: SearchQueryDto, @CurrentUser() user?: User) {
    return this.searchService.search(query, user?._id?.toString());
  }

  /**
   * The tags people are actually posting under — what the Search screen shows
   * before anything is typed.
   *
   *   GET /search/trending?limit=6
   *
   * May legitimately come back empty while there is little tagged content; the
   * client hides the row rather than showing filler.
   */
  @Get('trending')
  trending(@Query('limit') limit = 6) {
    return this.searchService.trendingTags(Number(limit) || 6);
  }

  /** @deprecated Superseded by GET /search. Kept until the app is off it. */
  @UseGuards(OptionalJwtAuthGuard)
  @Get('global')
  globalSearch(
    @Query('q') q: string,
    @Query('page') page = 1,
    @Query('limit') limit = 12,
  ) {
    return this.searchService.globalSearch(q, Number(page), Number(limit));
  }

  /** @deprecated Superseded by GET /search?type=videos. */
  @Get('videos')
  searchVideos(@Query('q') q: string, @Query('page') page = 1) {
    return this.searchService.searchVideos(q, Number(page));
  }

  /** @deprecated Superseded by GET /search?type=users. */
  @Get('users')
  searchUsers(@Query('q') q: string, @Query('page') page = 1) {
    return this.searchService.searchUsers(q, Number(page));
  }
}

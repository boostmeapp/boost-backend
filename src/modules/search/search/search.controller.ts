import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('videos')
  searchVideos(
    @Query('q') q: string,
    @Query('page') page = 1,
  ) {
    return this.searchService.searchVideos(q, Number(page));
  }

  @Get('users')
  searchUsers(
    @Query('q') q: string,
    @Query('page') page = 1,
  ) {
    return this.searchService.searchUsers(q, Number(page));
  }
  @Get()
searchAll(
  @Query('q') q: string,
  @Query('page') page = 1,
) {
  if (!q || q.trim().length < 2) {
    return { users: [], videos: [] };
  }

  return this.searchService.globalSearch(q, Number(page));
}

}

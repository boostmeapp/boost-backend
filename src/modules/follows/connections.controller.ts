import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { ConnectionsService } from './connections.service';
import { ConnectionsQueryDto } from './dto/connections-query.dto';
import { OptionalJwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';

/**
 * The followers screens: Followers · Following · Suggested on your own
 * profile, Mutuals · Followers · Following on someone else's.
 *
 * Every list is paged (`page`, `limit`, default ten) and returns
 * `{ items, page, limit, total, hasMore }`, which is what the app's
 * load-more-on-scroll list expects.
 *
 * The guard is optional: a guest can browse a public profile's lists, they
 * just get `isFollowing: false` on every row.
 */
@Controller('connections')
@UseGuards(OptionalJwtAuthGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService) {}

  /** Accounts to follow next. Personalised only when signed in. */
  @Get('suggested')
  getSuggested(@CurrentUser() viewer: User | undefined, @Query() query: ConnectionsQueryDto) {
    return this.connections.getSuggested(this.viewerId(viewer), query);
  }

  /** Tab counts and the first mutual faces for a profile header. */
  @Get(':userId/summary')
  getSummary(@CurrentUser() viewer: User | undefined, @Param('userId') userId: string) {
    return this.connections.getSummary(userId, this.viewerId(viewer));
  }

  @Get(':userId/followers')
  getFollowers(
    @CurrentUser() viewer: User | undefined,
    @Param('userId') userId: string,
    @Query() query: ConnectionsQueryDto,
  ) {
    return this.connections.getFollowers(userId, this.viewerId(viewer), query);
  }

  @Get(':userId/following')
  getFollowing(
    @CurrentUser() viewer: User | undefined,
    @Param('userId') userId: string,
    @Query() query: ConnectionsQueryDto,
  ) {
    return this.connections.getFollowing(userId, this.viewerId(viewer), query);
  }

  /** Followers of this profile that the signed-in viewer also follows. */
  @Get(':userId/mutuals')
  getMutuals(
    @CurrentUser() viewer: User | undefined,
    @Param('userId') userId: string,
    @Query() query: ConnectionsQueryDto,
  ) {
    return this.connections.getMutuals(userId, this.viewerId(viewer), query);
  }

  private viewerId(viewer?: User) {
    return viewer?._id ? String(viewer._id) : undefined;
  }
}

import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FollowsService } from './follows.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { PaginationDto } from './dto/pagination.dto';

@Controller('follows')
@UseGuards(JwtAuthGuard)
export class FollowsController {
  constructor(private readonly followsService: FollowsService) {}

  // Follow a user
 @Post(':userId')
async follow(@CurrentUser() user: User, @Param('userId') userId: string) {
  return this.followsService.follow(user._id.toString(), userId);
}

@Delete(':userId')
async unfollow(@CurrentUser() user: User, @Param('userId') userId: string) {
  await this.followsService.unfollow(user._id.toString(), userId);
  return { message: 'Successfully unfollowed user' };
}


  // Get followers of any user (including logged-in user)
  @Get(':userId/followers')
  async getFollowers(
    @Param('userId') userId: string,
    @Query() query: PaginationDto,
  ) {
    return this.followsService.getFollowers(userId, query.page, query.limit);
  }

  // Get following list of any user (including logged-in user)
  @Get(':userId/following')
  async getFollowing(
    @Param('userId') userId: string,
    @Query() query: PaginationDto,
  ) {
    return this.followsService.getFollowing(userId, query.page, query.limit);
  }

  // Check if logged-in user is following another user
  @Get(':userId/is-following')
  async isFollowing(@CurrentUser() user: User, @Param('userId') userId: string) {
    const following = await this.followsService.isFollowing(user.id, userId);
    return { isFollowing: following };
  }
}

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { RewardService } from './reward.service';
import { RecordWatchDto } from './dto';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';

@Controller('rewards')
@UseGuards(JwtAuthGuard)
export class RewardController {
  constructor(private readonly rewardService: RewardService) {}

  // Watch tracking and earning
  @Post('watch')
  @HttpCode(HttpStatus.OK)
  async recordWatch(
    @CurrentUser() user: User,
    @Body() dto: RecordWatchDto,
  ) {
    return this.rewardService.recordVideoWatch(
      user.id,
      dto.videoId,
      dto.watchDuration,
    );
  }

  // Video reward pool info
  @Get('video/:videoId')
  async getVideoRewardPool(@Param('videoId') videoId: string) {
    return this.rewardService.getVideoRewardPool(videoId);
  }
}

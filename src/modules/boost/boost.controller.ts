import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { BoostService } from './boost.service';
import { CreateBoostDto } from './dto';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { REWARD_CONFIG } from '../../database/schemas/boost/boost.schema';

@Controller('boost')
@UseGuards(JwtAuthGuard)
export class BoostController {
  constructor(private readonly boostService: BoostService) {}

  @Get('config')
  getBoostConfig() {
    return {
      minAmount: REWARD_CONFIG.MIN_BOOST_AMOUNT,
      maxAmount: REWARD_CONFIG.MAX_BOOST_AMOUNT,
      rewardPoolPercentage: REWARD_CONFIG.REWARD_POOL_PERCENTAGE,
      platformRevenuePercentage: REWARD_CONFIG.PLATFORM_REVENUE_PERCENTAGE,
      rewardPerView: REWARD_CONFIG.FIXED_REWARD_PER_VIEW,
      description: `Pay any amount between £${REWARD_CONFIG.MIN_BOOST_AMOUNT} and £${REWARD_CONFIG.MAX_BOOST_AMOUNT}. ${REWARD_CONFIG.REWARD_POOL_PERCENTAGE * 100}% goes to reward pool, ${REWARD_CONFIG.PLATFORM_REVENUE_PERCENTAGE * 100}% is platform revenue.`,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createBoost(@CurrentUser() user: User, @Body() dto: CreateBoostDto) {
    return this.boostService.createBoost(user.id, dto.videoId, dto.amount);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancelBoost(@CurrentUser() user: User, @Param('id') id: string) {
    return this.boostService.cancelBoost(user.id, id);
  }
}

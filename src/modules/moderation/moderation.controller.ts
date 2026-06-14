import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { CreateReportDto } from './dto/create-report.dto';

@Controller('moderation')
@UseGuards(JwtAuthGuard)
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  createReport(@CurrentUser() user: User, @Body() dto: CreateReportDto) {
    return this.moderationService.createReport(user._id.toString(), dto);
  }

  @Post('block/:userId')
  @HttpCode(HttpStatus.OK)
  blockUser(@CurrentUser() user: User, @Param('userId') userId: string) {
    return this.moderationService.blockUser(user._id.toString(), userId);
  }

  @Delete('block/:userId')
  @HttpCode(HttpStatus.OK)
  unblockUser(@CurrentUser() user: User, @Param('userId') userId: string) {
    return this.moderationService.unblockUser(user._id.toString(), userId);
  }

  @Get('blocked')
  getBlockedUsers(@CurrentUser() user: User) {
    return this.moderationService.getBlockedUsers(user._id.toString());
  }
}

import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SupportService } from './support.service';
import { DataExportService } from './data-export.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { User } from '../../database/schemas/user/user.schema';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';

@Controller('support')
@UseGuards(JwtAuthGuard)
export class SupportController {
  constructor(
    private readonly supportService: SupportService,
    private readonly dataExportService: DataExportService,
  ) {}

  // Every accepted request sends an email, so this is capped well below the global limit.
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  submit(@CurrentUser() user: User, @Body() dto: CreateSupportRequestDto) {
    return this.supportService.submit(user, dto);
  }

  // Gathering and emailing a full export is expensive; keep it infrequent.
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('data-export')
  @HttpCode(HttpStatus.OK)
  requestDataExport(@CurrentUser() user: User) {
    return this.dataExportService.emailExport(user);
  }
}

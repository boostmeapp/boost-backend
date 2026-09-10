import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { MailerService } from '../mailer/mailer.service';
import { User } from '../../database/schemas/user/user.schema';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(private readonly mailerService: MailerService) {}

  async submit(user: User, dto: CreateSupportRequestDto) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();

    const delivered = await this.mailerService.sendSupportRequest({
      type: dto.type,
      category: dto.category?.trim() || 'General',
      message: dto.message.trim(),
      fromEmail: user.email,
      fromName: name || undefined,
      userId: user._id.toString(),
    });

    if (!delivered) {
      this.logger.error(
        `[SUPPORT] Undelivered ${dto.type} from ${user.email}: ${dto.message.trim()}`,
      );
      throw new InternalServerErrorException(
        'We could not send your message right now. Please email us directly.',
      );
    }

    return {
      success: true,
      message: 'Your message has been sent to our support team.',
    };
  }
}

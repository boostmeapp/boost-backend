import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { CommentResponse } from './interfaces/comment.interface';
import { User } from './decorators/user.decorator';

@Controller('comments')
@UseGuards(JwtAuthGuard)
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  @Post()
  create(@User('id') userId: string, @Body() dto: CreateCommentDto) {
    return this.commentsService.create(userId, dto);
  }

  @Get('video/:videoId')
  getVideoComments(
    @Param('videoId') videoId: string,
    @Query('page') page = 1,
  ): Promise<CommentResponse[]> {
    return this.commentsService.getVideoComments(videoId, Number(page));
  }

  @Get('replies/:commentId')
  getReplies(@Param('commentId') commentId: string) {
    return this.commentsService.getReplies(commentId);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @User('id') userId: string) {
    return this.commentsService.softDelete(id, userId);
  }
}

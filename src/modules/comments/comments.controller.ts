import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
    @User('id') userId: string,
    @Param('videoId') videoId: string,
    @Query('page') page = 1,
  ): Promise<CommentResponse[]> {
    return this.commentsService.getVideoComments(
      videoId,
      Number(page),
      20,
      userId,
    );
  }

  @Get('replies/:commentId')
  getReplies(@User('id') userId: string, @Param('commentId') commentId: string) {
    return this.commentsService.getReplies(commentId, userId);
  }

  @Post(':id/like')
  @HttpCode(HttpStatus.OK)
  toggleLike(@User('id') userId: string, @Param('id') commentId: string) {
    return this.commentsService.toggleLike(userId, commentId);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @User('id') userId: string) {
    return this.commentsService.softDelete(id, userId);
  }
}

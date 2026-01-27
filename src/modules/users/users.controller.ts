import {
  Controller,
  Get,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto, ChangePasswordDto } from './dto';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { User, UserRole } from '../../database/schemas/user/user.schema';
import { RolesGuard } from '../../common/guards';
import { VideoService } from '../video/video.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService,private readonly videoService: VideoService,) {}
  @Patch('me')
async updateMe(
  @CurrentUser() user: User,
  @Body() updateUserDto: UpdateUserDto,
) {
  return this.usersService.update(user.id, updateUserDto);
}

@Get(':id/profile')
@Public()
async getProfile(
  @Param('id') userId: string,
  @CurrentUser() viewer?: User,
) {
  return this.usersService.getProfile(viewer?.id ?? null, userId);
}

  @Get('me')
  getCurrentUser(@CurrentUser() user: User) {
    return user;
  }
@Patch('me/profile-image')
@UseGuards(JwtAuthGuard)
async updateProfileImage(
  @CurrentUser() user: User,
  @Body('profileImage') profileImage: string,
) {
  return this.usersService.update(user.id, { profileImage });
}


  @Get()
  @Roles(UserRole.ADMIN)
  findAll() {
    return this.usersService.findAll();
  }

  @Patch('password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: User,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    await this.usersService.changePassword(user.id, changePasswordDto);
    return { message: 'Password changed successfully' };
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
  @Get(':id/videos')
@Public()
async getUserProfileVideos(
  @Param('id') userId: string,
  @Query('page') page?: string,
  @Query('limit') limit?: string,
) {
  return this.videoService.getProfileVideos(
    userId,
    page ? Number(page) : 1,
    limit ? Number(limit) : 12,
  );
}

}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StreamVideoService } from './stream-video.service';

@Module({
  imports: [ConfigModule],
  providers: [StreamVideoService],
  exports: [StreamVideoService],
})
export class CallModule {}

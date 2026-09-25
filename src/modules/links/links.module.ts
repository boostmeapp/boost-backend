import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { LinksController } from './links.controller';
import { LinksService } from './links.service';

/** Serves the universal-link files and the shared-video landing page. */
@Module({
  imports: [MongooseModule.forFeature([{ name: Video.name, schema: VideoSchema }])],
  controllers: [LinksController],
  providers: [LinksService],
  exports: [LinksService],
})
export class LinksModule {}

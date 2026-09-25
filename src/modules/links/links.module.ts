import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Video, VideoSchema } from '../../database/schemas/video/video.schema';
import { LinksController } from './links.controller';

/** Serves the universal-link files and the shared-video landing page. */
@Module({
  imports: [MongooseModule.forFeature([{ name: Video.name, schema: VideoSchema }])],
  controllers: [LinksController],
})
export class LinksModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { StreamVideoService } from './stream-video.service';
import { CallService } from './call.service';
import { CallController } from './call.controller';
import { Call, CallSchema } from '../../database/schemas/call/call.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Call.name, schema: CallSchema }]),
  ],
  controllers: [CallController],
  providers: [StreamVideoService, CallService],
  exports: [StreamVideoService, CallService],
})
export class CallModule {}

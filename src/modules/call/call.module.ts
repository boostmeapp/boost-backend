import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { StreamVideoService } from './stream-video.service';
import { Call, CallSchema } from '../../database/schemas/call/call.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Call.name, schema: CallSchema }]),
  ],
  providers: [StreamVideoService],
  exports: [StreamVideoService],
})
export class CallModule {}

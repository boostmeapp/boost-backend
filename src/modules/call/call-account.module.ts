import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallModule } from './call.module';
import { CallAccountCleanupService } from './call-account-cleanup.service';
import { Call, CallSchema } from '../../database/schemas/call/call.schema';

/**
 * Global so the account-deletion paths (AuthModule, AdminModule) can inject
 * the cleanup without importing CallModule — whose import chain (chat →
 * upload → users → …) could otherwise close a cycle back to them.
 */
@Global()
@Module({
  imports: [
    CallModule,
    MongooseModule.forFeature([{ name: Call.name, schema: CallSchema }]),
  ],
  providers: [CallAccountCleanupService],
  exports: [CallAccountCleanupService],
})
export class CallAccountModule {}

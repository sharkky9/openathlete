import { Module, forwardRef } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';

import { AuthModule } from '../auth';
import { CoreModule } from '../core';
import { PrismaService } from '../prisma/services/prisma.service';
import { QueueModule } from '../queue';
import { ProviderOAuthController } from './controllers/provider-oauth.controller';
import { ProviderImportScheduler } from './provider-import.scheduler';
import { IntervalsIcuProviderService } from './providers/intervals-icu.provider.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuthModule,
    forwardRef(() => CoreModule),
    EventEmitterModule,
    forwardRef(() => QueueModule),
  ],
  controllers: [ProviderOAuthController],
  providers: [
    PrismaService,
    ProviderImportScheduler,
    IntervalsIcuProviderService,
  ],
  exports: [IntervalsIcuProviderService],
})
export class ProvidersSyncModule {}

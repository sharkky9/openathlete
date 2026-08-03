import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma/services/prisma.service';
import { HealthController } from './health.controller';
import { HealthService } from './services/health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService, PrismaService],
})
export class HealthModule {}

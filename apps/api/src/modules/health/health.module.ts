import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaService } from '../prisma/services/prisma.service';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [PrismaService, HealthService],
  exports: [HealthService],
})
export class HealthModule {}

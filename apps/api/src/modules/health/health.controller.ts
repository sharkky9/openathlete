import { Response } from 'express';

import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HealthService, PublicReadiness } from './services/health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns the health status of the API process without touching any dependency. Used by the platform health check (Railway `healthcheckPath`), load balancers and uptime monitors to verify the process is running and responsive.',
  })
  @ApiResponse({
    status: 200,
    description: 'API is healthy and operational',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          example: 'ok',
          description: 'Health status indicator',
        },
      },
      required: ['status'],
    },
  })
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Checks the dependencies the API needs to serve traffic (Postgres and Redis). Returns 503 when any dependency is unreachable, so alerting can distinguish "process alive" from "able to serve traffic". The endpoint is unauthenticated, so it only reports the aggregate status; which dependency failed is written to the logs. Results are cached for a few seconds so anonymous traffic cannot amplify into dependency load.',
  })
  @ApiResponse({
    status: 200,
    description: 'All dependencies are reachable',
    schema: {
      type: 'object',
      properties: { status: { type: 'string', example: 'ok' } },
      required: ['status'],
    },
  })
  @ApiResponse({ status: 503, description: 'At least one dependency is down' })
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicReadiness> {
    const report = await this.healthService.getReadiness();

    response.status(
      report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return { status: report.status };
  }
}

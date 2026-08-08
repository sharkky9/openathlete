import { Response } from 'express';

import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HealthService } from './health.service';

@ApiTags('App')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness check endpoint',
    description:
      'Reports whether the API can actually serve traffic by probing its hard dependencies (Postgres and Redis). Unlike `/health`, which only proves the process is alive, this endpoint is the deploy gate: a new deployment is not promoted until it answers 200. The response is intentionally status-only — per-dependency failure detail is written to the logs so the endpoint cannot leak infrastructure topology to unauthenticated callers. Results are cached for a few seconds and concurrent callers share a single check.',
  })
  @ApiResponse({
    status: 200,
    description:
      'All dependencies are reachable; the instance can serve traffic',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          example: 'ok',
          description: 'Readiness status indicator',
        },
      },
      required: ['status'],
    },
  })
  @ApiResponse({
    status: 503,
    description:
      'At least one dependency is unreachable; see the API logs for which one',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          example: 'error',
          description: 'Readiness status indicator',
        },
      },
      required: ['status'],
    },
  })
  async ready(@Res({ passthrough: true }) res: Response) {
    const { ready } = await this.healthService.isReady();

    if (!ready) {
      // Deliberately not an exception: `SentryGlobalFilter` would report every
      // dependency blip, and Nest's default error body would add
      // `statusCode`/`message`/`error` keys to a status-only contract.
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'error' };
    }

    return { status: 'ok' };
  }
}

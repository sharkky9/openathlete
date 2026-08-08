import { Response } from 'express';

import { HttpStatus } from '@nestjs/common';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// Guards the HTTP half of the readiness contract that gates deployments: the
// status mapping (ready -> 200, not ready -> 503) and the status-only body.
// The service spec covers `{ ready: false }`; this covers what the caller sees.

type MockResponse = { status: jest.Mock };

function buildController(ready: boolean) {
  const healthService = {
    isReady: jest.fn().mockResolvedValue({ ready }),
  };
  const res: MockResponse = { status: jest.fn() };

  const controller = new HealthController(
    healthService as unknown as HealthService,
  );

  return { controller, healthService, res };
}

describe('HealthController', () => {
  describe('ready', () => {
    it('returns a status-only ok body without overriding the status code', async () => {
      const { controller, healthService, res } = buildController(true);

      const body = await controller.ready(res as unknown as Response);

      expect(body).toEqual({ status: 'ok' });
      expect(healthService.isReady).toHaveBeenCalledTimes(1);
      // The 200 comes from Nest's default for @Get, not an explicit override.
      expect(res.status).not.toHaveBeenCalled();
    });

    it('responds 503 with a status-only error body when not ready', async () => {
      const { controller, healthService, res } = buildController(false);

      const body = await controller.ready(res as unknown as Response);

      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(body).toEqual({ status: 'error' });
      expect(healthService.isReady).toHaveBeenCalledTimes(1);
    });

    it('never leaks dependency detail in the 503 body', async () => {
      // The endpoint is unauthenticated, so the failure body must stay
      // status-only: adding a per-dependency field here is the regression.
      const { controller, res } = buildController(false);

      const body = await controller.ready(res as unknown as Response);

      expect(Object.keys(body)).toEqual(['status']);
    });
  });
});

import request from 'supertest';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

// Import order matters here. `src/modules/auth` (the barrel) participates in an
// import cycle through the core services, so whichever file is required first
// wins: entering through a service leaves `AuthService` undefined in the
// controller's `design:paramtypes` and Nest then fails to resolve it. The app
// itself enters through AuthModule -> controllers, so the spec does the same by
// importing the controller before the services. Keep it that way.
import { AuthController } from 'src/modules/auth/controllers/auth.controller';
import { ThrottleGuard } from 'src/modules/auth/guards';
import { AuthService } from 'src/modules/auth/services/auth.service';
import { InvitationService } from 'src/modules/auth/services/invitation.service';
import { UserService } from 'src/modules/auth/services/user.service';

// Guards the two hardening decisions made on the unauthenticated auth surface.
//
// 1. Rate limiting (issue #47). Every route on this controller is reachable
//    without credentials, so the throttle is the only thing bounding a
//    credential-stuffing run. The contract is exact, not "some 429 shows up":
//    a single client gets exactly `limit` requests inside the window, every
//    request after that is rejected with 429, and the budget comes back when
//    the window rolls over. A regression that widened the limit, dropped the
//    guard, or never expired a window would still let "some" 429 through, so
//    the assertions pin all three boundaries.
//
// 2. `GET /auth/email-exists` (issue #41) leaked whether an address had an
//    account here, to anyone who asked. It is neutralized rather than deleted
//    (fork maintenance: deleting an upstream route conflicts on every future
//    merge). The contract is that it answers 410 and never reaches the
//    database — a handler that returned a hardcoded `false` would pass a
//    status-only check while still burning a lookup, so both halves are
//    asserted.

const LOGIN_LIMIT = 10;
const WINDOW_MS = 60_000;
const BURST_SIZE = 100;

const CREDENTIALS = {
  email: 'user@example.com',
  password: 'securePassword123',
};

describe('AuthController (rate limiting & enumeration)', () => {
  let app: INestApplication;
  let authService: { login: jest.Mock };
  let userService: { exists: jest.Mock };
  let invitationService: { verifyInvitationToken: jest.Mock };

  const login = () =>
    request(app.getHttpServer()).post('/auth/login').send(CREDENTIALS);

  beforeEach(async () => {
    authService = {
      login: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    };
    userService = { exists: jest.fn().mockResolvedValue(true) };
    invitationService = { verifyInvitationToken: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        ThrottleGuard,
        { provide: AuthService, useValue: authService },
        { provide: UserService, useValue: userService },
        { provide: InvitationService, useValue: invitationService },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  describe('POST /auth/login', () => {
    it(`serves the first ${LOGIN_LIMIT} requests from one client and 429s the rest of a ${BURST_SIZE}-request burst`, async () => {
      const statuses: number[] = [];

      for (let i = 0; i < BURST_SIZE; i++) {
        statuses.push((await login()).status);
      }

      const allowed = statuses.slice(0, LOGIN_LIMIT);
      const blocked = statuses.slice(LOGIN_LIMIT);

      expect(allowed.filter((status) => status === 429)).toEqual([]);
      expect(blocked).toEqual(Array(BURST_SIZE - LOGIN_LIMIT).fill(429));
      // The throttle must reject, not merely count: the service is reached
      // exactly as many times as the limit allows.
      expect(authService.login).toHaveBeenCalledTimes(LOGIN_LIMIT);
    });

    it('restores the budget once the window has rolled over', async () => {
      // Only Date.now is moved, not the timer queue — faking timers wholesale
      // would stall supertest's own HTTP round trip.
      const start = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(start);

      for (let i = 0; i < LOGIN_LIMIT; i++) {
        expect((await login()).status).not.toBe(429);
      }
      expect((await login()).status).toBe(429);

      clock.mockReturnValue(start + WINDOW_MS + 1);

      expect((await login()).status).not.toBe(429);
    });

    it('reports the limit, the remaining budget and the retry delay', async () => {
      const first = await login();

      expect(first.headers['x-ratelimit-limit']).toBe(String(LOGIN_LIMIT));
      expect(first.headers['x-ratelimit-remaining']).toBe(
        String(LOGIN_LIMIT - 1),
      );

      let last = first;
      for (let i = 1; i <= LOGIN_LIMIT; i++) {
        last = await login();
      }

      expect(last.status).toBe(429);
      expect(last.headers['x-ratelimit-remaining']).toBe('0');
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('GET /auth/email-exists', () => {
    const emailExists = () =>
      request(app.getHttpServer())
        .get('/auth/email-exists')
        .query({ email: CREDENTIALS.email });

    it('answers 410 Gone without looking the address up', async () => {
      const response = await emailExists();

      expect(response.status).toBe(410);
      expect(userService.exists).not.toHaveBeenCalled();
    });

    it('does not disclose existence through the response body', async () => {
      const response = await emailExists();

      expect(response.body).not.toEqual(true);
      expect(response.body).not.toEqual(false);
    });
  });
});

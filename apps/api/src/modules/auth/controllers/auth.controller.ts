import { ZodValidationPipe } from 'nestjs-zod';

import {
  Body,
  Controller,
  Get,
  GoneException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  AuthResponseDto,
  FirebaseLoginDto,
  LoginDto,
  RefreshTokenDto,
  firebaseLoginDtoSchema,
  loginDtoSchema,
  refreshTokenDtoSchema,
} from '@openathlete/shared';

import { Throttle, ThrottleGuard } from '../guards';
import { AuthService } from '../services';
import { InvitationService } from '../services/invitation.service';

// Every route here is unauthenticated, so throttling is the only thing standing
// between an attacker and unlimited credential stuffing / token brute-forcing.
// The guard is applied per-controller rather than globally on purpose: a global
// APP_GUARD would also cover provider webhooks, which burst legitimately.
@ApiTags('Auth')
@Controller('auth')
@UseGuards(ThrottleGuard)
export class AuthController {
  // UserService is no longer injected: `GET /auth/email-exists` was its only
  // consumer here and is now neutralized, and an unread property fails
  // `noUnusedLocals`. The route itself stays — that is what fork maintenance
  // requires, not the dependency behind it.
  constructor(
    private authService: AuthService,
    private invitationService: InvitationService,
  ) {}

  @Post('login')
  @Throttle({ limit: 10, windowMs: 60_000 })
  @ApiOperation({
    summary: 'Authenticate user with email and password',
    description:
      'Validates user credentials and returns access and refresh tokens. The access token expires in 1 hour, while the refresh token expires in 30 days.',
  })
  @ApiBody({
    description: 'User login credentials',
    schema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          format: 'email',
          example: 'user@example.com',
        },
        password: {
          type: 'string',
          format: 'password',
          example: 'securePassword123',
        },
      },
      required: ['email', 'password'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Authentication successful',
    schema: {
      type: 'object',
      properties: {
        accessToken: {
          type: 'string',
          description: 'JWT access token (expires in 1 hour)',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSJ9...',
        },
        refreshToken: {
          type: 'string',
          description: 'JWT refresh token (expires in 30 days)',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSJ9...',
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials - email or password is incorrect',
  })
  async login(
    @Body(new ZodValidationPipe(loginDtoSchema)) credentials: LoginDto,
  ): Promise<AuthResponseDto> {
    return await this.authService.login(credentials);
  }

  @Post('firebase')
  @Throttle({ limit: 10, windowMs: 60_000 })
  @ApiOperation({
    summary: 'Authenticate user with Firebase OAuth (ID token exchange)',
    description:
      'Verifies a Firebase ID token (OAuth providers: Google/Apple/GitHub), creates a user if missing, and returns OpenAthlete access and refresh tokens.',
  })
  async loginWithFirebase(
    @Body(new ZodValidationPipe(firebaseLoginDtoSchema)) body: FirebaseLoginDto,
  ): Promise<AuthResponseDto> {
    return await this.authService.loginWithFirebase(body);
  }

  @Post('refresh-token')
  @Throttle({ limit: 20, windowMs: 60_000 })
  @ApiOperation({
    summary: 'Refresh access token using refresh token',
    description:
      'Generates a new pair of access and refresh tokens using a valid refresh token. Useful for maintaining user sessions without requiring re-authentication.',
  })
  @ApiBody({
    description: 'Refresh token request',
    schema: {
      type: 'object',
      properties: {
        refreshToken: {
          type: 'string',
          description: 'Valid refresh token',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSJ9...',
        },
      },
      required: ['refreshToken'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Token refresh successful',
    schema: {
      type: 'object',
      properties: {
        accessToken: {
          type: 'string',
          description: 'New JWT access token (expires in 1 hour)',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSJ9...',
        },
        refreshToken: {
          type: 'string',
          description: 'New JWT refresh token (expires in 30 days)',
          example:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsImVtYWlsIjoidXNlckBleGFtcGxlLmNvbSJ9...',
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid or expired refresh token',
  })
  async refreshToken(
    @Body(new ZodValidationPipe(refreshTokenDtoSchema)) body: RefreshTokenDto,
  ): Promise<AuthResponseDto> {
    return this.authService.refresh(body.refreshToken);
  }

  // Neutralized: this route let anyone confirm whether an address has an account
  // here, one request at a time, with no authentication (issue #41). Nothing
  // needs it — account creation already rejects duplicates with a 409, which is
  // the only place the answer is actually required and is scoped to a caller who
  // is submitting that address anyway. The route is kept (and made to fail
  // loudly with 410 rather than lie with `false`) because this is a fork:
  // deleting an upstream endpoint produces a modify/delete conflict on every
  // future upstream merge — see doc/fork-maintenance.md.
  @Get('email-exists')
  @Throttle({ limit: 5, windowMs: 60_000 })
  @ApiOperation({
    summary: 'Removed - check if an email address is already registered',
    deprecated: true,
    description:
      'Permanently removed: this endpoint allowed unauthenticated user enumeration. Account creation (POST /user) already returns 409 Conflict for an address that is taken, which covers the legitimate use case.',
  })
  @ApiQuery({
    name: 'email',
    type: String,
    description: 'Ignored - the email is never read',
    example: 'user@example.com',
    required: false,
  })
  @ApiResponse({
    status: 410,
    description:
      'Gone - endpoint permanently removed, use the 409 from POST /user instead',
  })
  async emailExists() {
    throw new GoneException(
      'This endpoint has been removed. Account creation returns 409 Conflict when the email is already registered.',
    );
  }

  @Get('invitation')
  // The response echoes back the invitation's email address, so an unthrottled
  // caller could mine addresses by guessing tokens (issue #41).
  @Throttle({ limit: 10, windowMs: 60_000 })
  @ApiOperation({
    summary: 'Verify invitation token validity',
    description:
      'Validates an invitation token and returns the associated email if valid. The token can be for either an athlete invitation or a coach invitation. Returns valid=false if the token is invalid or expired.',
  })
  @ApiQuery({
    name: 'token',
    type: String,
    description: 'Invitation token to verify',
    example: 'abc123def456...',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Invitation verification result',
    schema: {
      type: 'object',
      properties: {
        valid: {
          type: 'boolean',
          description: 'Whether the invitation token is valid',
          example: true,
        },
        email: {
          type: 'string',
          format: 'email',
          description:
            'Email address associated with the invitation (only present if valid=true)',
          example: 'invited@example.com',
        },
      },
      required: ['valid'],
    },
  })
  async verifyInvitation(@Query('token') token: string) {
    const invitation =
      await this.invitationService.verifyInvitationToken(token);
    if (!invitation) {
      return { valid: false };
    }
    return {
      valid: true,
      email: invitation.email,
    };
  }
}

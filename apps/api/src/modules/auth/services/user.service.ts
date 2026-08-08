import * as argon2 from 'argon2';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  Gender,
  MetricType,
  Prisma,
  SportType,
  TokenType,
  User,
  UserRole,
} from '@openathlete/database';
import {
  ApiEnvSchemaType,
  CompleteOnboardingDto,
  CreateAccountDto,
  PasswordResetDto,
  PasswordResetRequestDto,
  UpdateAccountDto,
} from '@openathlete/shared';

import { Language } from 'src/common/constants/languages.constant';
import { SendEmailEvent } from 'src/events';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

import { AuthUser } from '../decorators/user.decorator';
import { AthleteInvitationService } from './athlete-invitation.service';
import { CoachInvitationService } from './coach-invitation.service';
import { TokenService } from './token.service';

@Injectable()
export class UserService {
  private readonly logger = new Logger();
  HASH_PEPPER: Buffer | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<ApiEnvSchemaType, true>,
    private eventEmitter: EventEmitter2,
    private tokenService: TokenService,
    private invitationService: AthleteInvitationService,
    private coachInvitationService: CoachInvitationService,
  ) {
    this.HASH_PEPPER = this.configService.get('HASH_PEPPER')
      ? Buffer.from(this.configService.get('HASH_PEPPER'))
      : undefined;
  }

  async findOneOrFail(where: Prisma.UserWhereInput): Promise<User> {
    return this.prisma.user.findFirstOrThrow({ where });
  }

  async findOne(where: Prisma.UserWhereInput): Promise<User | null> {
    return this.prisma.user.findFirst({ where });
  }

  async exists(where: Prisma.UserWhereInput): Promise<boolean> {
    return this.prisma.user.findFirst({ where }).then((user) => !!user);
  }

  public hashPassword = async (plainPassword: string) =>
    await argon2.hash(plainPassword, {
      secret: this.HASH_PEPPER,
    });

  public getMe = async (user: AuthUser) => {
    return await this.prisma.user.findUniqueOrThrow({
      where: { userId: user.userId },
      select: {
        userId: true,
        email: true,
        firstName: true,
        lastName: true,
        gender: true,
        roles: true,
        onboardingCompleted: true,
        language: true,
      },
    });
  };

  public updateLanguage = async (user: AuthUser, language: Language) => {
    await this.prisma.user.update({
      where: { userId: user.userId },
      data: { language },
    });
    return { success: true };
  };

  public updatePushToken = async (user: AuthUser, pushToken: string) => {
    const currentUser = await this.prisma.user.findUnique({
      where: { userId: user.userId },
      select: { pushToken: true },
    });

    if (currentUser?.pushToken !== pushToken) {
      await this.prisma.user.update({
        where: { userId: user.userId },
        data: { pushToken: pushToken },
      });
      this.logger.log(`Updated push token for user ${user.userId}`);
    }

    return { success: true };
  };

  public createAccount = async ({
    email,
    password,
    firstName,
    lastName,
    invitationToken,
    coachInvitationToken,
  }: CreateAccountDto) => {
    const normalizedEmail = email.toLowerCase();
    const hashedPassword = await this.hashPassword(password);

    if (!hashedPassword) {
      throw new BadRequestException('Failed to hash password');
    }

    const userExists = await this.exists({ email: normalizedEmail });

    if (userExists) {
      throw new ConflictException('User already exists');
    }

    // Default 5-zone heart rate system for new athletes
    // Colors chosen to be coherent and compatible with color inputs (hex)
    const DEFAULT_HR_ZONES = [
      {
        name: 'Zone 1',
        description: 'Recovery',
        min: 0,
        max: 131,
        color: '#9CA3AF', // gray-400
      },
      {
        name: 'Zone 2',
        description: 'Endurance',
        min: 132,
        max: 142,
        color: '#22C55E', // green-500
      },
      {
        name: 'Zone 3',
        description: 'Tempo',
        min: 143,
        max: 152,
        color: '#EAB308', // yellow-500
      },
      {
        name: 'Zone 4',
        description: 'Threshold',
        min: 153,
        max: 163,
        color: '#F97316', // orange-500
      },
      {
        name: 'Zone 5',
        description: 'VO2 Max',
        min: 164,
        max: 220,
        color: '#EF4444', // red-500
      },
    ];

    const allSports = Object.values(SportType) as SportType[];

    const created = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        firstName: firstName,
        lastName: lastName,
        roles: [UserRole.ATHLETE],
        athlete: {
          create: {
            trainingZones: {
              create: DEFAULT_HR_ZONES.map((z, idx) => ({
                name: z.name,
                description: z.description,
                index: idx,
                type: 'HEARTRATE',
                color: z.color,
                values: {
                  create: [
                    {
                      min: z.min,
                      max: z.max,
                      sports: allSports,
                    },
                  ],
                },
              })),
            },
          },
        },
      },
      select: {
        userId: true,
      },
    });

    if (invitationToken) {
      await this.invitationService.consumeInvitation(
        invitationToken,
        created.userId,
      );
    }

    if (coachInvitationToken) {
      await this.coachInvitationService.consumeInvitation(
        coachInvitationToken,
        created.userId,
      );
    }

    this.eventEmitter.emit(
      SendEmailEvent.SLUG,
      new SendEmailEvent({
        type: 'welcome',
        to: normalizedEmail,
        params: {
          name: firstName,
          dashboard_url: `${this.configService.get('APP_URL')}/dashboard`,
        },
      }),
    );

    this.eventEmitter.emit(
      SendEmailEvent.SLUG,
      new SendEmailEvent({
        type: 'signup-notification',
        to: 'contact@openathlete.org',
        params: {
          email: normalizedEmail,
          firstName,
          lastName,
        },
      }),
    );

    return created;
  };

  public updateAccount = async (user: AuthUser, data: UpdateAccountDto) => {
    if (data.roles) {
      await this.assertRolesCanBeApplied(user, data.roles as UserRole[]);
    }

    return await this.prisma.user.update({
      where: { userId: user.userId },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        gender: data.gender,
        // `undefined` leaves the column alone; a present array replaces it
        // wholesale, so roles are removed as well as added — the same rule
        // `completeOnboarding` applies.
        roles: data.roles as UserRole[] | undefined,
      },
      select: {
        firstName: true,
        lastName: true,
        gender: true,
        roles: true,
      },
    });
  };

  /**
   * Guards a roles change made after onboarding.
   *
   * Dropping COACH from an account that still coaches athletes would orphan
   * those `CoachAthlete` rows: the coach keeps read access through CASL (which
   * reads the link, not the role) while the coaching surfaces disappear from
   * their UI. Rather than silently unlink other people's athletes, refuse and
   * make the user remove the links first.
   */
  private assertRolesCanBeApplied = async (
    user: AuthUser,
    roles: UserRole[],
  ) => {
    if (roles.includes(UserRole.COACH)) {
      return;
    }

    const coachedAthleteCount = await this.prisma.coachAthlete.count({
      where: { userId: user.userId },
    });

    if (coachedAthleteCount > 0) {
      throw new BadRequestException(
        'Cannot remove the COACH role while you still coach athletes. Remove your athletes first.',
      );
    }
  };

  async comparePasswords(
    params: { pass_string: string; pass_hash: string },
    options?: { email?: string },
  ) {
    const { pass_string, pass_hash } = params || {};
    const { email } = options || {};

    const areCredentialsValid = await argon2.verify(pass_hash, pass_string, {
      secret: this.HASH_PEPPER,
    });
    if (!areCredentialsValid) {
      this.logger.log(
        `Invalid credentials for user${email ? ` with email ${email}` : ''}`,
      );
      throw new UnauthorizedException();
    }

    return areCredentialsValid;
  }

  public passwordResetRequest = async (body: PasswordResetRequestDto) => {
    const user = await this.findOne({ email: body.email });
    if (!user) {
      this.logger.log(`User with email ${body.email} not found`);
      throw new UnauthorizedException();
    }

    const token = await this.tokenService.createToken(
      { userId: user.userId },
      TokenType.PASSWORD_RESET,
    );

    this.eventEmitter.emit(
      SendEmailEvent.SLUG,
      new SendEmailEvent({
        type: 'password-reset',
        to: body.email,
        params: {
          url: `${this.configService.get('APP_URL')}/auth/password-reset?token=${token.token}`,
        },
      }),
    );
  };

  public passwordReset = async (body: PasswordResetDto) => {
    const user = await this.tokenService.verifyToken(body.token);

    if (!user) {
      this.logger.log(`Token ${body.token} not found or expired`);
      throw new UnauthorizedException();
    }

    const hashedPassword = await this.hashPassword(body.password);

    if (!hashedPassword) {
      throw new BadRequestException('Failed to hash password');
    }

    await this.prisma.user.update({
      where: { userId: user.userId },
      data: { password: hashedPassword },
    });
  };

  public completeOnboarding = async (
    user: AuthUser,
    data: CompleteOnboardingDto,
  ) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Update user roles, gender, and mark onboarding as completed.
    // The onboarding selection is authoritative: roles the user did not select
    // are removed as well as added.
    await this.prisma.user.update({
      where: { userId: user.userId },
      data: {
        roles: data.roles as UserRole[],
        gender: data.gender as Gender | undefined,
        onboardingCompleted: true,
      },
    });

    // Get athlete record
    const athlete = await this.prisma.athlete.findUnique({
      where: { userId: user.userId },
    });

    if (!athlete) {
      throw new NotFoundException('Athlete record not found');
    }

    // Create metrics if provided
    const metricsToCreate: Array<{
      type: MetricType;
      date: Date;
      value: number;
    }> = [];

    if (data.weight) {
      metricsToCreate.push({
        type: 'WEIGHT',
        date: today,
        value: data.weight,
      });
    }

    if (data.height) {
      metricsToCreate.push({
        type: 'HEIGHT',
        date: today,
        value: data.height,
      });
    }

    if (data.hrMax) {
      metricsToCreate.push({
        type: 'HR_MAX',
        date: today,
        value: data.hrMax,
      });
    }

    if (data.hrRest) {
      metricsToCreate.push({
        type: 'HR_REST',
        date: today,
        value: data.hrRest,
      });
    }

    // Create metrics (upsert to avoid duplicates)
    for (const metric of metricsToCreate) {
      await this.prisma.athleteMetric.upsert({
        where: {
          athleteId_type_date: {
            athleteId: athlete.athleteId,
            type: metric.type,
            date: metric.date,
          },
        },
        create: {
          athleteId: athlete.athleteId,
          type: metric.type,
          date: metric.date,
          value: metric.value,
        },
        update: {
          value: metric.value,
        },
      });
    }

    // Invite coach if provided
    if (data.coachEmail && data.roles.includes('ATHLETE')) {
      await this.coachInvitationService.createInvitation(
        user.userId,
        data.coachEmail,
      );
    }

    // Invite athletes if provided
    if (
      data.athleteEmails &&
      data.athleteEmails.length > 0 &&
      data.roles.includes('COACH')
    ) {
      for (const email of data.athleteEmails) {
        try {
          await this.invitationService.createInvitation(user.userId, email);
        } catch (error) {
          // Log but don't fail the entire onboarding if one invitation fails
          this.logger.warn(`Failed to invite athlete ${email}: ${error}`);
        }
      }
    }

    return { success: true };
  };

  public deleteAccount = async (user: AuthUser) => {
    const userId = user.userId;

    // Get athlete if exists
    const athlete = await this.prisma.athlete.findUnique({
      where: { userId },
      select: { athleteId: true },
    });

    if (athlete) {
      const athleteId = athlete.athleteId;

      // Delete all events and related data (similar to event service deleteEvent)
      const events = await this.prisma.event.findMany({
        where: { athleteId },
        select: {
          eventId: true,
          training: { select: { workout: { select: { workoutId: true } } } },
        },
      });

      for (const event of events) {
        if (event.training?.workout?.workoutId) {
          // Delete provider exports for workouts
          await this.prisma.providerWorkoutExport.deleteMany({
            where: {
              workout: {
                eventTrainingId: event.eventId,
              },
            },
          });
        }

        // Delete workout-related data
        await this.prisma.workout.deleteMany({
          where: { eventTrainingId: event.eventId },
        });
        await this.prisma.eventTraining.deleteMany({
          where: { eventId: event.eventId },
        });
        await this.prisma.eventCompetition.deleteMany({
          where: { eventId: event.eventId },
        });
        await this.prisma.eventNote.deleteMany({
          where: { eventId: event.eventId },
        });

        // Delete activity-related data
        await this.prisma.eventActivityWeather.deleteMany({
          where: { eventActivity: { eventId: event.eventId } },
        });
        await this.prisma.eventActivityNormalizationFactor.deleteMany({
          where: {
            normalization: { eventActivity: { eventId: event.eventId } },
          },
        });
        await this.prisma.eventActivityNormalization.deleteMany({
          where: { eventActivity: { eventId: event.eventId } },
        });
        await this.prisma.record.deleteMany({
          where: { eventActivity: { event: { eventId: event.eventId } } },
        });
        await this.prisma.activityFeedbackQuestion.deleteMany({
          where: { activity: { eventId: event.eventId } },
        });
        await this.prisma.activityFeedbackEmbedding.deleteMany({
          where: { activity: { eventId: event.eventId } },
        });
        await this.prisma.eventActivity.deleteMany({
          where: { eventId: event.eventId },
        });
      }

      // Delete events
      await this.prisma.event.deleteMany({
        where: { athleteId },
      });

      // Delete athlete-related data
      const trainingZones = await this.prisma.trainingZone.findMany({
        where: { athleteId },
        include: {
          values: true,
        },
      });
      for (const trainingZone of trainingZones) {
        await this.prisma.trainingZoneValue.deleteMany({
          where: { trainingZoneId: trainingZone.trainingZoneId },
        });
      }
      await this.prisma.trainingZone.deleteMany({
        where: { athleteId },
      });
      await this.prisma.equipment.deleteMany({
        where: { athleteId },
      });
      await this.prisma.cycle.deleteMany({
        where: { athleteId },
      });
      await this.prisma.athleteMetric.deleteMany({
        where: { athleteId },
      });
      await this.prisma.trainingLoadCalculation.deleteMany({
        where: { athleteId },
      });
      await this.prisma.trainingPlan.deleteMany({
        where: { athleteId },
      });
      await this.prisma.athleteAvailability.deleteMany({
        where: { athleteId },
      });
      await this.prisma.providerAccount.deleteMany({
        where: { athleteId },
      });
      await this.prisma.providerWorkoutExport.deleteMany({
        where: { athlete: { athleteId } },
      });
      await this.prisma.athleteSettings.deleteMany({
        where: { athleteId },
      });
      await this.prisma.athleteInjury.deleteMany({
        where: { athleteId },
      });

      // Delete coach-athlete relationships
      await this.prisma.coachAthlete.deleteMany({
        where: { athleteId },
      });
    }

    // Delete user-related data
    await this.prisma.token.deleteMany({
      where: { userId },
    });
    await this.prisma.eventTemplate.deleteMany({
      where: { userId },
    });
    await this.prisma.agentThread.deleteMany({
      where: { userId },
    });
    await this.prisma.eventTemplateFolder.deleteMany({
      where: { userId },
    });
    await this.prisma.athleteInvitation.deleteMany({
      where: { userId },
    });
    await this.prisma.coachInvitation.deleteMany({
      where: { OR: [{ coachUserId: userId }, { athleteUserId: userId }] },
    });
    await this.prisma.messageThreadParticipant.deleteMany({
      where: { userId },
    });
    await this.prisma.message.deleteMany({
      where: { senderId: userId },
    });
    await this.prisma.messageReadReceipt.deleteMany({
      where: { userId },
    });
    await this.prisma.subscription.deleteMany({
      where: { userId },
    });
    await this.prisma.coachAthlete.deleteMany({
      where: { userId },
    });

    // Delete athlete record if exists
    if (athlete) {
      await this.prisma.athlete.delete({
        where: { athleteId: athlete.athleteId },
      });
    }

    // Finally, delete the user
    await this.prisma.user.delete({
      where: { userId },
    });

    this.logger.log(`Account deleted for user ${userId}`);

    return { success: true };
  };
}

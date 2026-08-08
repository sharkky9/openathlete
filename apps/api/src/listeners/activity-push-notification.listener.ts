import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { Language } from 'src/common/constants/languages.constant';
import { ActivityImportedEvent } from 'src/events';
import { getPushNotificationTranslation } from 'src/modules/notification/push';
import { PushNotificationService } from 'src/modules/notification/services/push-notification.service';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

@Injectable()
export class ActivityPushNotificationListener {
  private readonly logger = new Logger(ActivityPushNotificationListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushNotificationService: PushNotificationService,
  ) {}

  @OnEvent(ActivityImportedEvent.SLUG, { async: true })
  async handleActivityImported(event: ActivityImportedEvent) {
    const { eventActivityId, eventId, bulkImport } = event.payload;

    if (bulkImport) {
      return;
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const activity = await this.prisma.eventActivity.findUnique({
        where: { eventActivityId: eventActivityId },
        include: {
          event: {
            include: {
              athlete: {
                include: {
                  user: {
                    select: {
                      userId: true,
                      language: true,
                      pushToken: true,
                    },
                  },
                },
              },
            },
          },
          feedbackQuestions: {
            select: {
              activityFeedbackQuestionId: true,
            },
          },
        },
      });

      if (
        !activity ||
        !activity.event?.athleteId ||
        !activity.event.athlete?.user
      ) {
        this.logger.debug(
          `Activity ${eventActivityId} not found or has no user, skipping push notification`,
        );
        return;
      }

      const user = activity.event.athlete.user;
      const athleteId = activity.event.athleteId;

      if (!user.pushToken) {
        this.logger.debug(
          `User ${user.userId} does not have a push token, skipping notification`,
        );
        return;
      }

      const athleteSettings = await this.prisma.athleteSettings.findUnique({
        where: { athleteId: athleteId },
      });

      const feedbackQuestionsEnabled =
        athleteSettings?.requireFeedbackQuestions !== false;

      const hasQuestions = activity.feedbackQuestions.length > 0;

      const language = (user.language ?? Language.FR) as Language;
      const translation = getPushNotificationTranslation(
        'activity_processed',
        language,
        {
          hasQuestions: feedbackQuestionsEnabled && hasQuestions,
        },
      );

      await this.pushNotificationService.sendPushNotification({
        userId: user.userId,
        title: translation.title,
        body: translation.body,
        data: {
          type: 'activity_processed',
          eventId: String(eventId),
          eventActivityId: String(eventActivityId),
          hasQuestions: String(hasQuestions),
        },
      });

      this.logger.log(
        `Push notification sent for activity ${eventActivityId} to user ${user.userId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send push notification for activity ${eventActivityId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

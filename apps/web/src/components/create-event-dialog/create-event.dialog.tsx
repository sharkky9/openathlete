import { m } from '@/paraglide/messages';
import { eventTypeLabelMap } from '@/utils/label-map/core';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';

import type { CreateEventDto, Event } from '@openathlete/shared';
import { EVENT_TYPE } from '@openathlete/shared';

import { useCalendarContext } from '../calendar/hooks/use-calendar-context';
import { FormProvider } from '../hook-form';
import { RHFCheckbox } from '../hook-form/rhf-checkbox';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { EventFormFields } from './components/event-form-fields';
import { WorkoutSection } from './components/workout-section';
import { useEventFormSubmission } from './hooks/use-event-form-submission';
import { useWorkoutDuration } from './hooks/use-workout-duration';
import { useWorkoutSteps } from './hooks/use-workout-steps';
import { getEndDate, getStartDate } from './utils/date-helpers';
import {
  type EventFormValues,
  eventFormSchema,
} from './utils/event-form-schemas';
import { getFormDefaultValues } from './utils/form-default-values';

type P =
  | {
      open: boolean;
      onClose: () => void;
      date?: Date;
      type?: EVENT_TYPE;
      prefilledData?: CreateEventDto;
    }
  | {
      open: boolean;
      onClose: () => void;
      event?: Event;
      isTemplate?: boolean;
    };

export function CreateEventDialog({ open, onClose, ...rest }: P) {
  const { athleteId } = useCalendarContext();
  const edit = 'event' in rest;
  const create = 'type' in rest && 'date' in rest;

  const type = create
    ? ('type' in rest && rest.type) || EVENT_TYPE.TRAINING
    : edit
      ? ('event' in rest && rest.event?.type) || EVENT_TYPE.TRAINING
      : EVENT_TYPE.TRAINING;

  // Calculate dates
  const startDate = useMemo(() => {
    if (create) {
      return getStartDate(rest.date);
    } else if (edit) {
      return rest.event?.startDate;
    }
  }, [create, edit, rest]);

  const endDate = useMemo(() => {
    if (create) {
      // Calculate endDate from startDate + 1 hour
      const calculatedStartDate = getStartDate(rest.date);
      return getEndDate(rest.date, calculatedStartDate);
    } else if (edit) {
      return rest.event?.endDate;
    }
  }, [create, edit, rest]);

  // Initialize form
  const methods = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
    defaultValues: getFormDefaultValues(rest, startDate, endDate),
  });

  const { handleSubmit, setValue, watch } = methods;

  // Manage workout steps
  const { workoutSteps, setWorkoutSteps } = useWorkoutSteps(rest);

  // Calculate workout duration and update form
  const { hasStepsWithDuration } = useWorkoutDuration(
    workoutSteps,
    watch,
    setValue,
  );

  // Handle form submission
  const { onSubmit, isSubmitting } = useEventFormSubmission(
    rest,
    athleteId ?? 0,
    workoutSteps,
    onClose,
  );

  // Watch form values for UI
  const startDateValue = watch('startDate');
  const goalDistanceValue = watch('goalDistance');
  const goalDurationValue = watch('goalDuration');
  const sportValue = watch('sport');

  // Calculate endDate automatically when startDate or goalDuration changes
  useEffect(() => {
    if (
      startDateValue &&
      !hasStepsWithDuration &&
      (type === EVENT_TYPE.TRAINING || type === EVENT_TYPE.COMPETITION)
    ) {
      const duration = goalDurationValue || 3600; // Default 1 hour
      const start = new Date(startDateValue);
      const end = new Date(start);
      end.setSeconds(start.getSeconds() + duration);
      setValue('endDate', end, { shouldValidate: false });
    }
  }, [startDateValue, goalDurationValue, hasStepsWithDuration, type, setValue]);

  if (
    (create &&
      (!('date' in rest) || !rest.date || !('type' in rest) || !rest.type)) ||
    (edit && (!('event' in rest) || !rest.event))
  ) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        mobileFullscreen
        className="sm:max-w-4xl sm:max-h-[90vh] max-h-[100vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="flex flex-col md:flex-row items-start md:items-center justify-between gap-2 md:gap-2">
            <div className="flex items-center gap-2 grow text-sm md:text-base">
              {edit && 'isTemplate' in rest && rest.isTemplate
                ? m.edit_template()
                : edit
                  ? m.edit()
                  : m.plan()}{' '}
              {edit && 'isTemplate' in rest && rest.isTemplate ? '' : m.a()}{' '}
              {eventTypeLabelMap[type as keyof typeof eventTypeLabelMap]}
            </div>
          </DialogTitle>
        </DialogHeader>
        <FormProvider
          methods={methods}
          onSubmit={onSubmit(handleSubmit)}
          className="space-y-4 md:space-y-6 pt-3"
        >
          <EventFormFields
            type={type}
            hasStepsWithDuration={hasStepsWithDuration}
            startDateValue={startDateValue}
            goalDistanceValue={goalDistanceValue}
            goalDurationValue={goalDurationValue}
            setValue={setValue}
            isTemplate={edit && 'isTemplate' in rest && rest.isTemplate}
          />

          <WorkoutSection
            props={rest}
            type={type}
            workoutSteps={workoutSteps}
            setWorkoutSteps={setWorkoutSteps}
            sportValue={sportValue}
            athleteId={athleteId ?? undefined}
          />

          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3 md:gap-4">
            <Button type="submit" className="flex-1" isLoading={isSubmitting}>
              {edit ? m.edit() : m.create()} {m.the()}
              {eventTypeLabelMap[type as keyof typeof eventTypeLabelMap]}
            </Button>
            {create && (
              <RHFCheckbox
                name="saveAsTemplate"
                label={m.save_event_as_template()}
              />
            )}
          </div>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}

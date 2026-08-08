import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NewMessageThreadDialog } from './new-message-thread-dialog';

/**
 * Regression cover for two issues that meet in this component.
 *
 * #39 — a user with no coach and no coached athletes had nothing to select, so
 * Create stayed disabled and Messages sat at "0 conversations" forever. The
 * dialog now allows a thread the user is alone in, which is the smallest
 * payload the API accepts.
 *
 * #34 — the title, description, empty state and Cancel button were hardcoded
 * French literals, rendering "Nouvelle conversation" and "Annuler" next to an
 * English "Create" whatever the locale was set to. They now go through
 * Paraglide, which defaults to English in these tests.
 */

const coaches = vi.fn();
const coachedAthletes = vi.fn();
const currentUser = vi.fn();

vi.mock('@/api/athlete', () => ({
  useGetMyCoachesQuery: () => ({ data: coaches() }),
  useGetMyCoachedAthletesQuery: () => ({ data: coachedAthletes() }),
}));

vi.mock('@/api/user', () => ({
  useGetMeQuery: () => ({ data: currentUser() }),
}));

const ME = { userId: 1, firstName: 'Sam', lastName: 'Rider' };
const COACH = {
  userId: 2,
  firstName: 'Alex',
  lastName: 'Coach',
  email: 'alex@example.com',
};

const renderDialog = (onConfirm = vi.fn()) => {
  render(
    <NewMessageThreadDialog
      open
      onOpenChange={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
  return onConfirm;
};

describe('NewMessageThreadDialog', () => {
  beforeEach(() => {
    coaches.mockReturnValue([]);
    coachedAthletes.mockReturnValue([]);
    currentUser.mockReturnValue(ME);
  });

  describe('an account with no coach and no athletes (#39)', () => {
    it('leaves Create enabled instead of dead-ending the user', async () => {
      renderDialog();

      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
    });

    it('creates a thread containing just the current user', async () => {
      const onConfirm = renderDialog();

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(onConfirm).toHaveBeenCalledWith([ME.userId]);
    });

    it('explains the empty list rather than blaming the user', () => {
      renderDialog();

      expect(screen.getByText(/No one to add yet/i)).toBeInTheDocument();
    });
  });

  describe('an account with a coach', () => {
    beforeEach(() => {
      coaches.mockReturnValue([COACH]);
    });

    it('always puts the current user in the participant list', async () => {
      const onConfirm = renderDialog();

      await userEvent.click(screen.getByText('Alex Coach'));
      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(onConfirm).toHaveBeenCalledWith([ME.userId, COACH.userId]);
    });

    it('never offers the current user as someone to add', () => {
      coaches.mockReturnValue([COACH, ME]);
      renderDialog();

      expect(screen.queryByText('Sam Rider')).not.toBeInTheDocument();
    });
  });

  describe('localisation (#34)', () => {
    it('renders the title, description and Cancel through Paraglide', () => {
      renderDialog();

      // Under the default (English) locale these would previously have been
      // "Nouvelle conversation", "Sélectionnez les personnes…" and "Annuler".
      expect(screen.getByText('New conversation')).toBeInTheDocument();
      expect(
        screen.getByText('Select the people you want to talk to'),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Cancel' }),
      ).toBeInTheDocument();
    });

    it('has no hardcoded French left in the rendered dialog', () => {
      renderDialog();

      for (const literal of [
        'Nouvelle conversation',
        'Sélectionnez les personnes avec qui vous souhaitez dialoguer',
        'Aucune personne disponible pour démarrer une conversation',
        'Annuler',
      ]) {
        expect(screen.queryByText(literal)).not.toBeInTheDocument();
      }
    });
  });
});

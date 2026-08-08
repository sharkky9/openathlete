import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RolesSection } from './roles-section';

/**
 * Regression cover for the web half of #35 — "Settings: no way to change roles
 * after onboarding".
 *
 * `completeOnboarding` was the only writer of `roles` and `AuthGuard` will not
 * re-enter onboarding, so an athlete-only account had no way back. This section
 * has to be usable by exactly the account that has the problem — an athlete who
 * wants to coach — which means it must not be gated on already having the role.
 */

const mutate = vi.fn();
const invalidateQueries = vi.fn();
const initialize = vi.fn();
const authUser = vi.fn();
let mutationOptions: { onSuccess?: () => Promise<void> | void } = {};

vi.mock('@/api/user', () => ({
  useUpdateAccountMutation: (options: { onSuccess?: () => void }) => {
    mutationOptions = options;
    return { mutate, isPending: false };
  },
}));

vi.mock('@/contexts/auth', () => ({
  useAuthContext: () => ({ user: authUser(), initialize }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('RolesSection', () => {
  beforeEach(() => {
    mutate.mockReset();
    invalidateQueries.mockReset();
    initialize.mockReset();
    authUser.mockReturnValue({ userId: 1, roles: ['ATHLETE'] });
  });

  it('is visible to an athlete-only account', () => {
    render(<RolesSection />);

    expect(screen.getByText("I'm an athlete")).toBeInTheDocument();
    // The role the user does not have yet is the whole reason to be here.
    expect(screen.getByText("I'm a coach")).toBeInTheDocument();
  });

  it('marks the roles the account already has', () => {
    render(<RolesSection />);

    expect(
      screen.getByRole('button', { name: "I'm an athlete" }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: "I'm a coach" })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('submits the full role array, not just the added role', async () => {
    render(<RolesSection />);

    await userEvent.click(screen.getByRole('button', { name: "I'm a coach" }));
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    // The API treats the array as authoritative, so ATHLETE has to be resent.
    expect(mutate).toHaveBeenCalledWith({ roles: ['ATHLETE', 'COACH'] });
  });

  it('can drop a role as well as add one', async () => {
    authUser.mockReturnValue({ userId: 1, roles: ['ATHLETE', 'COACH'] });
    render(<RolesSection />);

    await userEvent.click(screen.getByRole('button', { name: "I'm a coach" }));
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(mutate).toHaveBeenCalledWith({ roles: ['ATHLETE'] });
  });

  it('refuses to submit an empty selection', async () => {
    render(<RolesSection />);

    await userEvent.click(
      screen.getByRole('button', { name: "I'm an athlete" }),
    );

    // SpaceProvider and the sidebar assume at least one role, so the button is
    // disabled rather than sending a payload the API would reject.
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('does nothing while the selection matches the saved roles', () => {
    render(<RolesSection />);

    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
  });

  it('refreshes both caches on success so the sidebar picks the change up', async () => {
    render(<RolesSection />);

    await mutationOptions.onSuccess?.();

    await waitFor(() => expect(initialize).toHaveBeenCalled());
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['UserAPI.getMe'],
    });
  });
});

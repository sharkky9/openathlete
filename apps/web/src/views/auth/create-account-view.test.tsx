import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateAccountDto, LoginDto } from '@openathlete/shared';

import { CreateAccountView } from './create-account-view';

/**
 * Regression coverage for #80's complete user-facing contract. Account
 * creation belongs to the form's submit event so mouse and keyboard paths use
 * the same single request, followed by login, auth initialization and
 * onboarding navigation. Duplicate addresses retain their specific feedback.
 */

type CreateOptions = {
  onSuccess?: (data: unknown, variables: CreateAccountDto) => void;
  onError?: (error: Error) => void;
};

type LoginOptions = {
  onSuccess?: () => Promise<void> | void;
  onError?: () => void;
};

const mocks = vi.hoisted(() => ({
  createAccount: vi.fn<(variables: CreateAccountDto) => void>(),
  login: vi.fn<(variables: LoginDto) => void>(),
  initialize: vi.fn<() => Promise<void>>(),
  navigate: vi.fn(),
  capture: vi.fn(),
  toastError: vi.fn(),
  options: {
    create: {} as CreateOptions,
    login: {} as LoginOptions,
  },
}));

vi.mock('@/api/user', () => ({
  useCreateAccountMutation: (options: CreateOptions) => {
    mocks.options.create = options;
    return { mutate: mocks.createAccount, isPending: false };
  },
}));

vi.mock('@/api/auth', () => ({
  useLoginMutation: (options: LoginOptions) => {
    mocks.options.login = options;
    return { mutate: mocks.login, isPending: false };
  },
}));

vi.mock('@/contexts/auth', () => ({
  useAuthContext: () => ({ initialize: mocks.initialize }),
}));

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: mocks.capture }),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock('@/views/auth/oauth-buttons', () => ({
  OAuthButtons: () => null,
}));

const account: CreateAccountDto = {
  firstName: 'Test',
  lastName: 'Athlete',
  email: 'athlete@example.com',
  password: 'password123',
};

const renderView = () =>
  render(
    <MemoryRouter>
      <CreateAccountView />
    </MemoryRouter>,
  );

const fillForm = async () => {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('John'), account.firstName);
  await user.type(screen.getByPlaceholderText('Doe'), account.lastName);
  await user.type(screen.getByPlaceholderText('m@example.com'), account.email);
  await user.type(
    document.querySelector('input[name="password"]')!,
    account.password,
  );
  return user;
};

describe('CreateAccountView', () => {
  beforeEach(() => {
    mocks.createAccount.mockReset();
    mocks.login.mockReset();
    mocks.initialize.mockReset();
    mocks.initialize.mockResolvedValue();
    mocks.navigate.mockReset();
    mocks.capture.mockReset();
    mocks.toastError.mockReset();
    mocks.options.create = {};
    mocks.options.login = {};
  });

  it('makes exactly one account request when the submit button is clicked', async () => {
    renderView();
    const user = await fillForm();

    await user.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledTimes(1));
    expect(mocks.createAccount).toHaveBeenCalledWith(account);
  });

  it('makes exactly one account request when the form is submitted with Enter', async () => {
    renderView();
    const user = await fillForm();

    await user.type(
      document.querySelector('input[name="password"]')!,
      '{Enter}',
    );

    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledTimes(1));
    expect(mocks.createAccount).toHaveBeenCalledWith(account);
  });

  it('logs the new account in and opens onboarding after creation', async () => {
    renderView();

    mocks.options.create.onSuccess?.({}, account);
    expect(mocks.capture).toHaveBeenCalledWith('user_signed_up');
    expect(mocks.login).toHaveBeenCalledWith(account);

    await mocks.options.login.onSuccess?.();

    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/dashboard/onboarding');
  });

  it('shows the specific already-registered message for a duplicate email', () => {
    renderView();
    const duplicate = new AxiosError('Conflict');
    duplicate.response = {
      status: 409,
      statusText: 'Conflict',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {},
    };

    mocks.options.create.onError?.(duplicate);

    expect(mocks.toastError).toHaveBeenCalledWith(
      'An account already exists with this email address',
    );
  });
});

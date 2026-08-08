import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyConnectDialog } from './api-key-connect-dialog';

const mutate = vi.fn();

vi.mock('@/api/provider', () => ({
  useSetProviderCredentialsMutation: () => ({
    mutate,
    isPending: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('ApiKeyConnectDialog', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('connects with the server-configured key when the field is blank', async () => {
    render(
      <ApiKeyConnectDialog provider="INTERVALS_ICU" onOpenChange={vi.fn()} />,
    );

    expect(
      screen.getByText(/connection configured on this OpenAthlete server/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Personal API key \(optional\)/i)).toHaveValue(
      '',
    );

    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).toBeEnabled();
    await userEvent.click(connect);

    expect(mutate).toHaveBeenCalledWith({ provider: 'INTERVALS_ICU' });
  });

  it('trims and submits a personal key when the user overrides the server key', async () => {
    render(
      <ApiKeyConnectDialog provider="INTERVALS_ICU" onOpenChange={vi.fn()} />,
    );

    await userEvent.type(
      screen.getByLabelText(/Personal API key \(optional\)/i),
      '  personal-key  ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(mutate).toHaveBeenCalledWith({
      provider: 'INTERVALS_ICU',
      apiKey: 'personal-key',
    });
  });
});

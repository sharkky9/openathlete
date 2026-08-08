import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthButtons } from './oauth-buttons';

vi.mock('@/api/auth', () => ({
  useLoginWithFirebaseMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock('@/contexts/auth', () => ({
  useAuthContext: () => ({ initialize: vi.fn() }),
}));

vi.mock('@/utils/capacitor', () => ({
  isCapacitor: () => false,
}));

vi.mock('posthog-js/react', () => ({
  usePostHog: () => undefined,
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

describe('OAuthButtons', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not advertise Google sign-in when Firebase is not configured', () => {
    render(<OAuthButtons />);

    expect(
      screen.queryByRole('button', { name: /continue with google/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/or continue with/i)).not.toBeInTheDocument();
  });

  it('does not advertise Google sign-in with a partial Firebase config', () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'api-key');
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'auth.example.com');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'project-id');

    render(<OAuthButtons />);

    expect(
      screen.queryByRole('button', { name: /continue with google/i }),
    ).not.toBeInTheDocument();
  });

  it('advertises Google sign-in when all Firebase variables are configured', () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'api-key');
    vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'auth.example.com');
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'project-id');
    vi.stubEnv('VITE_FIREBASE_APP_ID', 'app-id');

    render(<OAuthButtons />);

    expect(
      screen.getByRole('button', { name: /continue with google/i }),
    ).toBeInTheDocument();
  });
});

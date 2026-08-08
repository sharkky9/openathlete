import { isCapacitor } from '@/utils/capacitor';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { initializeApp } from 'firebase/app';
import {
  type Auth,
  GithubAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  getAuth,
  signInWithPopup,
} from 'firebase/auth';

export type OAuthProviderId = 'google';

type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

function readFirebaseWebConfig(): Partial<FirebaseWebConfig> {
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
    appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  };
}

function isFirebaseWebConfigComplete(
  config: Partial<FirebaseWebConfig>,
): config is FirebaseWebConfig {
  return Object.values(config).every(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

export function isFirebaseAuthenticationConfigured(): boolean {
  return isCapacitor() || isFirebaseWebConfigComplete(readFirebaseWebConfig());
}

function getFirebaseWebConfig(): FirebaseWebConfig {
  const config = readFirebaseWebConfig();

  if (!isFirebaseWebConfigComplete(config)) {
    throw new Error('Firebase web config is missing (VITE_FIREBASE_*)');
  }

  return config;
}

let webAuth: Auth | null = null;

function getWebAuth(): Auth {
  if (webAuth) return webAuth;

  const config = getFirebaseWebConfig();
  const app = initializeApp(config);
  webAuth = getAuth(app);
  return webAuth;
}

export async function getFirebaseIdTokenForProvider(
  providerId: OAuthProviderId,
): Promise<string> {
  if (isCapacitor()) {
    switch (providerId) {
      case 'google':
        await FirebaseAuthentication.signInWithGoogle();
        break;
    }

    const { token } = await FirebaseAuthentication.getIdToken({
      forceRefresh: false,
    });
    return token;
  }

  const auth = getWebAuth();

  if (providerId === 'google') {
    const provider = new GoogleAuthProvider();
    const { user } = await signInWithPopup(auth, provider);
    return await user.getIdToken();
  }

  if (providerId === 'github') {
    const provider = new GithubAuthProvider();
    // GitHub may not return email without this scope.
    provider.addScope('user:email');
    const { user } = await signInWithPopup(auth, provider);
    return await user.getIdToken();
  }

  const provider = new OAuthProvider('apple.com');
  provider.addScope('email');
  provider.addScope('name');
  const { user } = await signInWithPopup(auth, provider);
  return await user.getIdToken();
}

export async function signOutFirebase(): Promise<void> {
  if (isCapacitor()) {
    await FirebaseAuthentication.signOut();
    return;
  }

  // Only sign out if Firebase was initialized on web.
  if (!webAuth) return;
  await webAuth.signOut();
}

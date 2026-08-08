import { SITE_URL } from '@/config';
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OpenAthlete — Open-source endurance training platform',
    short_name: 'OpenAthlete',
    description:
      'OpenAthlete helps athletes plan training, track load and review progress in an open-source platform they can self-host.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#000000',
    icons: [
      {
        src: '/favicon.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/favicon.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
    categories: ['sports', 'health', 'fitness'],
    lang: 'en',
    dir: 'ltr',
    orientation: 'portrait-primary',
    scope: SITE_URL,
  };
}

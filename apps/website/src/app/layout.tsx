import {
  OrganizationStructuredData,
  WebSiteStructuredData,
} from '@/components/seo/structured-data';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';

const inter = Inter({ subsets: ['latin'] });

/* eslint-disable react-refresh/only-export-components */
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || 'https://openathlete.org',
  ),
  title: {
    default: 'OpenAthlete — Open-source endurance training platform',
    template: '%s | OpenAthlete',
  },
  description:
    'OpenAthlete helps coaches and athletes plan training, review activities, and collaborate with transparent, open-source training tools.',
  keywords: [
    'endurance coaching',
    'training platform',
    'athlete management',
    'training analysis',
    'fatigue prevention',
  ],
  authors: [{ name: 'OpenAthlete' }],
  creator: 'OpenAthlete',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    alternateLocale: 'fr_FR',
    url: 'https://openathlete.org',
    siteName: 'OpenAthlete',
    title: 'OpenAthlete — Open-source endurance training platform',
    description:
      'OpenAthlete helps coaches and athletes plan training, review activities, and collaborate with transparent, open-source training tools.',
    images: [
      {
        url: '/logo_dark.png',
        width: 1200,
        height: 630,
        alt: 'OpenAthlete',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OpenAthlete — Open-source endurance training platform',
    description:
      'OpenAthlete helps coaches and athletes plan training, review activities, and collaborate with transparent, open-source training tools.',
    images: ['/logo_dark.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  icons: {
    icon: [
      { url: '/favicon.png', type: 'image/png' },
      { url: '/favicon.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon.png', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: '/favicon.png',
    apple: '/favicon.png',
  },
};
/* eslint-enable react-refresh/only-export-components */

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Note: lang attribute will be set dynamically in [locale]/layout.tsx
  // Default to 'en' for root layout (will be overridden by locale layout)
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <OrganizationStructuredData />
        <WebSiteStructuredData />
        {children}
      </body>
    </html>
  );
}

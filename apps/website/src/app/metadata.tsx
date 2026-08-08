import { SITE_URL } from '@/config';
import type { Metadata } from 'next';

interface GenerateMetadataOptions {
  locale?: string;
  title?: string;
  description?: string;
  path?: string;
  keywords?: string[];
}

export function generateMetadata(options?: GenerateMetadataOptions): Metadata {
  const {
    locale = 'en',
    title: customTitle,
    description: customDescription,
    path = '',
    keywords,
  } = options || {};

  // Default metadata (English)
  const defaultTitle =
    'OpenAthlete — Ethical European open-source alternative to TrainingPeaks & Strava';
  const defaultDescription =
    'AGPLv3 endurance training platform: EU-oriented hosting, transparent CTL/ATL/TSB logic in code, and self-hosting. Built in Grenoble.';

  // French metadata
  const frTitle =
    'OpenAthlete — Alternative européenne open source à TrainingPeaks et Strava';
  const frDescription =
    "Plateforme d'endurance sous AGPLv3 : hébergement orienté UE, logique CTL/ATL/TSB lisible dans le code et auto-hébergement. Développée à Grenoble.";

  // Coaches page metadata
  const coachesTitleEn = 'OpenAthlete — For Coaches';
  const coachesDescriptionEn =
    'This page has been removed for now. OpenAthlete is an open-source endurance training platform hosted in the EU.';
  const coachesTitleFr = 'OpenAthlete — Pour les coachs';
  const coachesDescriptionFr =
    'Cette page est provisoirement retirée. OpenAthlete est une plateforme open source orientée Union européenne.';

  // Clubs page metadata
  const clubsTitleEn = 'OpenAthlete — For Clubs';
  const clubsDescriptionEn =
    'This page has been removed for now. OpenAthlete is an open-source endurance training platform hosted in the EU.';
  const clubsTitleFr = 'OpenAthlete — Pour les clubs';
  const clubsDescriptionFr =
    'Cette page est provisoirement retirée. OpenAthlete est une plateforme open source orientée Union européenne.';

  // Determine title and description based on path
  let title: string;
  let description: string;

  if (path === '/coaches') {
    title = customTitle || (locale === 'fr' ? coachesTitleFr : coachesTitleEn);
    description =
      customDescription ||
      (locale === 'fr' ? coachesDescriptionFr : coachesDescriptionEn);
  } else if (path === '/clubs') {
    title = customTitle || (locale === 'fr' ? clubsTitleFr : clubsTitleEn);
    description =
      customDescription ||
      (locale === 'fr' ? clubsDescriptionFr : clubsDescriptionEn);
  } else {
    title = customTitle || (locale === 'fr' ? frTitle : defaultTitle);
    description =
      customDescription ||
      (locale === 'fr' ? frDescription : defaultDescription);
  }
  const ogLocale = locale === 'fr' ? 'fr_FR' : 'en_US';
  const alternateLocale = locale === 'fr' ? 'en_US' : 'fr_FR';
  const localePath = locale === 'fr' ? '/fr' : '';
  const currentUrl = `${SITE_URL}${localePath}${path}`;
  // Canonical URL should always point to the English version
  const canonicalUrl = `${SITE_URL}${path}`;

  return {
    title,
    description,
    ...(keywords && { keywords }),
    openGraph: {
      title,
      description,
      url: currentUrl,
      siteName: 'OpenAthlete',
      images: [
        {
          url: `${SITE_URL}/logo_dark.png`,
          width: 1200,
          height: 630,
          alt: 'OpenAthlete',
        },
      ],
      locale: ogLocale,
      alternateLocale,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [`${SITE_URL}/logo_dark.png`],
    },
    alternates: {
      canonical: canonicalUrl,
      languages: {
        en: `${SITE_URL}${path}`,
        fr: `${SITE_URL}/fr${path}`,
        'x-default': `${SITE_URL}${path}`,
      },
    },
  };
}

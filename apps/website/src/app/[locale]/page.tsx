import {
  Comparison,
  FAQ,
  Features,
  FinalCTA,
  Footer,
  Hero,
  Navbar,
  OpenSource,
  Problem,
  Science,
  Solution,
  TopBar,
} from '@/components/landing/sections';
import { WebPageStructuredData } from '@/components/seo/structured-data';
import { SITE_URL } from '@/config';
import { m } from '@/paraglide/messages';
import { notFound } from 'next/navigation';

import { generateMetadata as generatePageMetadata } from '../metadata';

/* eslint-disable react-refresh/only-export-components */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return generatePageMetadata({ locale });
}
/* eslint-enable react-refresh/only-export-components */

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (locale !== 'en' && locale !== 'fr') {
    notFound();
  }

  return (
    <>
      <WebPageStructuredData
        title={m.landing_seo_title()}
        description={m.landing_seo_description()}
        url={`${SITE_URL}${locale === 'en' ? '' : `/${locale}`}`}
      />
      <div className="min-h-screen bg-background">
        <TopBar />
        <Navbar />
        <Hero />
        <Problem />
        <Solution />
        <Features />
        <Comparison />
        <Science />
        <OpenSource />
        <FAQ locale={locale} />
        <FinalCTA />
        <Footer />
      </div>
    </>
  );
}

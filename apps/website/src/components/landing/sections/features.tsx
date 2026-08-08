import featuresImage from '@/assets/images/landing/stats.png';
import { Container } from '@/components/landing/container';
import { FeatureCard } from '@/components/landing/feature-card';
import { ImagePlaceholder } from '@/components/landing/image-placeholder';
import { LandingSectionHeader } from '@/components/landing/landing-canvas';
import { Section } from '@/components/landing/section';
import { m } from '@/paraglide/messages';
import {
  CalendarDays,
  ClipboardList,
  LineChart,
  MessageCircle,
  RefreshCw,
  TabletSmartphone,
} from 'lucide-react';

const icons = [
  CalendarDays,
  LineChart,
  RefreshCw,
  ClipboardList,
  MessageCircle,
  TabletSmartphone,
];

export function Features() {
  const features = [
    {
      title: m.landing_features_card_1_title(),
      description: m.landing_features_card_1_desc(),
    },
    {
      title: m.landing_features_card_2_title(),
      description: m.landing_features_card_2_desc(),
    },
    {
      title: m.landing_features_card_3_title(),
      description: m.landing_features_card_3_desc(),
    },
    {
      title: m.landing_features_card_4_title(),
      description: m.landing_features_card_4_desc(),
    },
    {
      title: m.landing_features_card_5_title(),
      description: m.landing_features_card_5_desc(),
    },
    {
      title: m.landing_features_card_6_title(),
      description: m.landing_features_card_6_desc(),
    },
  ];

  return (
    <Section id="features" surface="soft">
      <Container>
        <LandingSectionHeader
          title={m.landing_features_title()}
          titleId="features-heading"
        />

        <div className="relative mx-auto mt-12 max-w-5xl">
          <div
            className="pointer-events-none absolute -inset-3 rounded-[1.35rem] bg-gradient-to-tr from-primary/15 via-transparent to-violet-500/10 opacity-80 blur-2xl dark:opacity-60"
            aria-hidden
          />
          <div className="relative rounded-2xl p-[1px] shadow-[0_24px_70px_-28px_rgba(0,0,0,0.2)] ring-1 ring-border/45 dark:shadow-black/40">
            <div className="overflow-hidden rounded-[calc(1rem-1px)] bg-gradient-to-b from-muted/30 to-background/80 dark:from-muted/15 dark:to-background/40">
              <ImagePlaceholder
                description="OpenAthlete interface showing planning, load curves, and integrations"
                aspectRatio="16/9"
                className="border-0 shadow-none ring-0"
                imageSrc={featuresImage}
              />
            </div>
          </div>
        </div>

        <div className="mx-auto mt-14 max-w-6xl">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
            {features.map((feature, index) => {
              const Icon = icons[index];
              return (
                <FeatureCard
                  key={index}
                  title={feature.title}
                  description={feature.description}
                  icon={
                    <Icon className="h-5 w-5 text-primary" strokeWidth={1.75} />
                  }
                />
              );
            })}
          </div>
        </div>
      </Container>
    </Section>
  );
}

import { Container } from '@/components/landing/container';
import { LandingSectionHeader } from '@/components/landing/landing-canvas';
import { Section } from '@/components/landing/section';
import { m } from '@/paraglide/messages';
import { cn } from '@/utils/shadcn';
import { AlertTriangle, Check, X } from 'lucide-react';

type CompareStatus = 'yes' | 'no' | 'partial';

type CompareCell =
  | { kind: 'plain'; text: () => string }
  | { kind: 'status'; status: CompareStatus; text?: () => string };

function compareStatusLabel(status: CompareStatus): string {
  switch (status) {
    case 'yes':
      return m.landing_compare_status_yes();
    case 'no':
      return m.landing_compare_status_no();
    case 'partial':
      return m.landing_compare_status_partial();
  }
}

function CompareCellContent({
  cell,
  emphasize,
}: {
  cell: CompareCell;
  emphasize: boolean;
}) {
  if (cell.kind === 'plain') {
    return (
      <span
        className={cn(
          emphasize ? 'text-foreground/90' : 'text-muted-foreground',
        )}
      >
        {cell.text()}
      </span>
    );
  }

  const label = (cell.text?.() ?? '').trim();
  const Icon =
    cell.status === 'yes' ? Check : cell.status === 'no' ? X : AlertTriangle;
  const iconClass = cn(
    'mt-0.5 h-4 w-4 shrink-0 stroke-[2.5]',
    cell.status === 'yes' && 'text-emerald-600 dark:text-emerald-500',
    cell.status === 'no' && 'text-muted-foreground/60',
    cell.status === 'partial' && 'text-amber-600 dark:text-amber-500',
  );

  return (
    <span
      className="inline-flex items-start gap-2.5"
      {...(label
        ? {}
        : { role: 'img', 'aria-label': compareStatusLabel(cell.status) })}
    >
      <Icon className={iconClass} aria-hidden />
      {label ? (
        <span
          className={cn(
            emphasize ? 'text-foreground/90' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}

export function Comparison() {
  const rows: {
    feature: () => string;
    openathlete: CompareCell;
    trainingpeaks: CompareCell;
    strava: CompareCell;
    intervals: CompareCell;
  }[] = [
    {
      feature: m.landing_compare_row_1_feature,
      openathlete: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_1_oa,
      },
      trainingpeaks: { kind: 'status', status: 'no' },
      strava: { kind: 'status', status: 'no' },
      intervals: { kind: 'status', status: 'no' },
    },
    {
      feature: m.landing_compare_row_2_feature,
      openathlete: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_2_oa,
      },
      trainingpeaks: { kind: 'status', status: 'no' },
      strava: { kind: 'status', status: 'no' },
      intervals: { kind: 'status', status: 'no' },
    },
    {
      feature: m.landing_compare_row_3_feature,
      openathlete: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_3_oa,
      },
      trainingpeaks: {
        kind: 'status',
        status: 'no',
        text: m.landing_compare_row_3_tp,
      },
      strava: {
        kind: 'status',
        status: 'no',
        text: m.landing_compare_row_3_strava,
      },
      intervals: {
        kind: 'status',
        status: 'partial',
        text: m.landing_compare_row_3_intervals,
      },
    },
    {
      feature: m.landing_compare_row_4_feature,
      openathlete: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_4_oa,
      },
      trainingpeaks: {
        kind: 'status',
        status: 'partial',
        text: m.landing_compare_row_4_tp,
      },
      strava: {
        kind: 'status',
        status: 'partial',
        text: m.landing_compare_row_4_strava,
      },
      intervals: {
        kind: 'status',
        status: 'partial',
        text: m.landing_compare_row_4_intervals,
      },
    },
    {
      feature: m.landing_compare_row_5_feature,
      openathlete: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_5_oa,
      },
      trainingpeaks: {
        kind: 'status',
        status: 'no',
        text: m.landing_compare_row_5_tp,
      },
      strava: {
        kind: 'status',
        status: 'no',
        text: m.landing_compare_row_5_strava,
      },
      intervals: {
        kind: 'status',
        status: 'partial',
        text: m.landing_compare_row_5_intervals,
      },
    },
    {
      feature: m.landing_compare_row_6_feature,
      openathlete: {
        kind: 'status',
        status: 'no',
        text: m.landing_compare_row_6_oa,
      },
      trainingpeaks: {
        kind: 'status',
        status: 'partial',
        text: m.landing_compare_row_6_tp,
      },
      strava: {
        kind: 'status',
        status: 'partial',
        text: m.landing_compare_row_6_strava,
      },
      intervals: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_6_intervals,
      },
    },
    {
      feature: m.landing_compare_row_7_feature,
      openathlete: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_7_oa,
      },
      trainingpeaks: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_7_tp,
      },
      strava: {
        kind: 'status',
        status: 'no',
        text: m.landing_compare_row_7_strava,
      },
      intervals: {
        kind: 'status',
        status: 'yes',
        text: m.landing_compare_row_7_intervals,
      },
    },
  ];

  return (
    <Section id="comparison" surface="ridge">
      <Container>
        <LandingSectionHeader
          title={m.landing_compare_title()}
          titleId="comparison-heading"
        />

        <div className="mx-auto mt-12 max-w-5xl">
          <div className="relative rounded-2xl border border-border/50 bg-card/30 p-px shadow-[0_20px_50px_-24px_rgba(0,0,0,0.16)] backdrop-blur-md dark:bg-card/15 dark:shadow-black/30">
            <div className="overflow-hidden rounded-[calc(1rem-1px)] bg-gradient-to-br from-card/90 via-card/70 to-muted/15 dark:from-card/40 dark:via-card/25 dark:to-muted/10">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/40 dark:bg-muted/20">
                      <th className="p-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:p-4 sm:text-[13px]">
                        {m.landing_compare_header_feature()}
                      </th>
                      <th className="p-4 text-xs font-semibold uppercase tracking-wide text-primary sm:text-[13px]">
                        {m.landing_compare_header_oa()}
                      </th>
                      <th className="p-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:text-[13px]">
                        {m.landing_compare_header_tp()}
                      </th>
                      <th className="p-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:text-[13px]">
                        {m.landing_compare_header_strava()}
                      </th>
                      <th className="p-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:text-[13px]">
                        {m.landing_compare_header_intervals()}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr
                        key={index}
                        className={cn(
                          'border-b border-border/35 transition-colors last:border-0 hover:bg-muted/25 dark:hover:bg-muted/10',
                        )}
                      >
                        <th
                          scope="row"
                          className="p-4 align-top text-[13px] font-medium text-foreground sm:p-4 sm:text-sm"
                        >
                          {row.feature()}
                        </th>
                        <td className="p-4 align-top text-[13px] sm:text-sm">
                          <CompareCellContent
                            cell={row.openathlete}
                            emphasize
                          />
                        </td>
                        <td className="p-4 align-top text-[13px] sm:text-sm">
                          <CompareCellContent
                            cell={row.trainingpeaks}
                            emphasize={false}
                          />
                        </td>
                        <td className="p-4 align-top text-[13px] sm:text-sm">
                          <CompareCellContent
                            cell={row.strava}
                            emphasize={false}
                          />
                        </td>
                        <td className="p-4 align-top text-[13px] sm:text-sm">
                          <CompareCellContent
                            cell={row.intervals}
                            emphasize={false}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </Container>
    </Section>
  );
}

import { ConnectorProvider } from '../../../entities';

export type ProviderSyncCapabilities = {
  importActivities: boolean;
  exportWorkouts: boolean;
  importMetrics: boolean;
  supportsFullImport: boolean;
};

const defaultCapabilities: ProviderSyncCapabilities = {
  importActivities: true,
  exportWorkouts: true,
  importMetrics: true,
  supportsFullImport: false,
};

const providerSpecificCapabilities: Partial<
  Record<ConnectorProvider, ProviderSyncCapabilities>
> = {
  STRAVA: {
    importActivities: true,
    exportWorkouts: false,
    importMetrics: false,
    supportsFullImport: true,
  },
  GARMIN: {
    importActivities: true,
    exportWorkouts: true,
    importMetrics: true,
    supportsFullImport: true,
  },
  FITBIT: {
    importActivities: false,
    exportWorkouts: false,
    importMetrics: true,
    supportsFullImport: false,
  },
  APPLE_HEALTH: {
    importActivities: false,
    exportWorkouts: false,
    importMetrics: true,
    supportsFullImport: false,
  },
  SUUNTO: {
    importActivities: true,
    exportWorkouts: true,
    importMetrics: true,
    supportsFullImport: true,
  },
  COROS: {
    importActivities: true,
    exportWorkouts: true,
    importMetrics: false,
    supportsFullImport: false,
  },
  POLAR: {
    importActivities: true,
    exportWorkouts: false,
    importMetrics: true,
    supportsFullImport: true,
  },
  // Intervals.icu is an aggregator: activities (and their full 1 Hz streams) arrive
  // from whatever the athlete has connected upstream (Garmin, Zwift, Strava, uploads).
  // - importMetrics is false on purpose: the wellness endpoint exists, but in practice
  //   it only reliably carries Intervals' own CTL/ATL. HRV / sleep / weight are sparse
  //   to non-existent, so claiming metrics support would be misleading.
  // - exportWorkouts is false for now: POST /events is supported by the API but writing
  //   planned workouts back is deliberately out of scope for this integration.
  INTERVALS_ICU: {
    importActivities: true,
    exportWorkouts: false,
    importMetrics: false,
    supportsFullImport: true,
  },
};

export function getProviderSyncCapabilities(
  provider: ConnectorProvider,
): ProviderSyncCapabilities {
  return providerSpecificCapabilities[provider] ?? defaultCapabilities;
}

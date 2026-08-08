import { FactoryProvider } from '@nestjs/common';

import { ActivityPipelineService } from './services/pipeline/activity-pipeline.service';
import {
  GapProcessor,
  NormalizationProcessor,
  TrainingMatchProcessor,
  WeatherProcessor,
} from './services/pipeline/processors';

export const activityPipelineProvider: FactoryProvider<ActivityPipelineService> =
  {
    provide: ActivityPipelineService,
    useFactory: (
      gap: GapProcessor,
      weather: WeatherProcessor,
      normalization: NormalizationProcessor,
      trainingMatch: TrainingMatchProcessor,
    ) =>
      new ActivityPipelineService([gap, weather, normalization, trainingMatch]),
    inject: [
      GapProcessor,
      WeatherProcessor,
      NormalizationProcessor,
      TrainingMatchProcessor,
    ],
  };

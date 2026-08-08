import { activityPipelineProvider } from './activity-pipeline.provider';
import { ActivityPipelineService } from './services/pipeline/activity-pipeline.service';
import {
  GapProcessor,
  NormalizationProcessor,
  TrainingMatchProcessor,
  WeatherProcessor,
} from './services/pipeline/processors';
import { ActivityProcessor } from './services/pipeline/types';

describe('CoreModule activity pipeline provider', () => {
  it('wires every activity processor to the pipeline in order', async () => {
    const provider = activityPipelineProvider;
    expect(provider.provide).toBe(ActivityPipelineService);

    const processor = (name: string): ActivityProcessor => ({
      name,
      run: jest.fn().mockResolvedValue(undefined),
    });
    const gap = processor('gap');
    const weather = processor('weather');
    const normalization = processor('normalization');
    const trainingMatch = processor('training-match');

    const dependencies = new Map<unknown, unknown>([
      [GapProcessor, gap],
      [WeatherProcessor, weather],
      [NormalizationProcessor, normalization],
      [TrainingMatchProcessor, trainingMatch],
    ]);
    const inject = provider.inject ?? [];
    const pipeline = await provider.useFactory(
      ...inject.map((token) => dependencies.get(token)),
    );
    const context = { eventActivityId: 10, eventId: 20 };

    await pipeline.run(context);

    expect(inject).toEqual([
      GapProcessor,
      WeatherProcessor,
      NormalizationProcessor,
      TrainingMatchProcessor,
    ]);
    for (const activityProcessor of [
      gap,
      weather,
      normalization,
      trainingMatch,
    ]) {
      expect(activityProcessor.run).toHaveBeenCalledTimes(1);
      expect(activityProcessor.run).toHaveBeenCalledWith(context);
    }
  });
});

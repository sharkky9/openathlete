import { Job } from 'bullmq';

import { Processor, WorkerHost } from '@nestjs/bullmq';

import {
  FullImportCompletionJobData,
  FullImportCompletionService,
} from '../services/full-import-completion.service';

@Processor('full-import-completion', {
  concurrency: 1,
})
export class FullImportCompletionProcessor extends WorkerHost {
  constructor(
    private readonly fullImportCompletionService: FullImportCompletionService,
  ) {
    super();
  }

  async process(job: Job<FullImportCompletionJobData>) {
    return this.fullImportCompletionService.reconcile(
      job.data.providerAccountId,
      job.data.runId,
    );
  }
}

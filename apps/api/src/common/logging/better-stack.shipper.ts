import axios from 'axios';

import { BetterStackLogConfig } from './better-stack.config';

export type BetterStackLevel =
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'trace'
  | 'fatal';

export interface BetterStackLogEvent {
  dt: string;
  level: BetterStackLevel;
  message: string;
  context?: string;
  stack?: string;
}

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 100;
const MAX_BUFFER_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 5000;
const TERMINATION_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Buffers log events and ships them to the Better Stack HTTP ingestion API in
 * batches. Shipping failures never surface to callers: logging must not be able
 * to take the API down, so failed batches are dropped after a single warning.
 */
export class BetterStackLogShipper {
  private buffer: BetterStackLogEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private hasWarned = false;
  private stopped = false;

  constructor(private readonly config: BetterStackLogConfig) {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();

    for (const signal of TERMINATION_SIGNALS) {
      const handler = () => this.handleSignal(signal, handler);
      process.once(signal, handler);
    }
    process.once('beforeExit', () => {
      void this.shutdown();
    });
  }

  enqueue(event: BetterStackLogEvent): void {
    if (this.stopped) {
      return;
    }

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
    this.buffer.push(event);

    if (this.buffer.length >= MAX_BATCH_SIZE) {
      void this.flush();
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Stop accepting records before draining: the API is still serving traffic
    // until the signal is re-raised, so new logs could otherwise refill the
    // buffer as fast as it drains and stall the shutdown.
    this.stopped = true;

    // flush() sends at most one batch, so drain what is buffered: the records
    // written right before a redeploy are the interesting ones. Bounded so an
    // unreachable ingestion host cannot hold the process past its grace period.
    const maxBatches = Math.ceil(MAX_BUFFER_SIZE / MAX_BATCH_SIZE);
    for (let i = 0; i < maxBatches && this.buffer.length > 0; i += 1) {
      await this.flush();
    }
  }

  /**
   * Flushes pending events and then hands the signal back. Listening for a
   * termination signal disables Node's default "terminate" behaviour, so the
   * signal is re-raised once no other listener (e.g. Nest shutdown hooks)
   * remains — otherwise the process would never exit on SIGTERM.
   */
  private handleSignal(signal: NodeJS.Signals, handler: () => void): void {
    void this.shutdown().finally(() => {
      process.removeListener(signal, handler);
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    });
  }

  /**
   * Sends at most one batch at a time. Queueing batches behind a slow ingestion
   * endpoint would retain them outside `buffer` and defeat its size cap, so
   * events stay buffered (and the oldest are dropped) until the socket frees up.
   */
  private flush(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    if (this.buffer.length === 0) {
      return Promise.resolve();
    }

    const batch = this.buffer.splice(0, MAX_BATCH_SIZE);
    this.inFlight = this.send(batch).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async send(batch: BetterStackLogEvent[]): Promise<void> {
    const payload = batch.map((event) => ({
      ...event,
      service: this.config.service,
      environment: this.config.environment,
    }));

    try {
      await axios.post(`https://${this.config.ingestingHost}`, payload, {
        headers: {
          Authorization: `Bearer ${this.config.sourceToken}`,
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (!this.hasWarned) {
        this.hasWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[BetterStack] dropping log batch, ingestion failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

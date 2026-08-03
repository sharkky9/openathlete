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
  private inFlight: Promise<void> = Promise.resolve();
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
    await this.flush();
    this.stopped = true;
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

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const batch = this.buffer.splice(0, MAX_BATCH_SIZE);
    this.inFlight = this.inFlight.then(() => this.send(batch));
    await this.inFlight;
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

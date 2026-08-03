import { ConsoleLogger, LoggerService } from '@nestjs/common';

import { resolveBetterStackLogConfig } from './better-stack.config';
import {
  BetterStackLevel,
  BetterStackLogShipper,
} from './better-stack.shipper';

/**
 * Console logger that also ships every log record to Better Stack. Console
 * output is kept so platform logs (Railway, Docker) stay complete even when
 * ingestion is unavailable.
 */
export class BetterStackLogger extends ConsoleLogger {
  constructor(private readonly shipper: BetterStackLogShipper) {
    super();
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(message, ...optionalParams);
    this.ship('info', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams);
    this.ship('warn', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    this.ship('error', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(message, ...optionalParams);
    this.ship('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(message, ...optionalParams);
    this.ship('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(message, ...optionalParams);
    this.ship('fatal', message, optionalParams);
  }

  private ship(
    level: BetterStackLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    // Nest passes the context as the last argument and, for errors, a stack
    // trace as the first optional argument.
    const params = [...optionalParams];
    const context =
      typeof params[params.length - 1] === 'string' && params.length > 0
        ? (params.pop() as string)
        : undefined;
    const stack =
      params.length > 0 ? params.map(stringify).join('\n') : undefined;

    this.shipper.enqueue({
      dt: new Date().toISOString(),
      level,
      message: stringify(message),
      context: context ?? this.context,
      stack,
    });
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Returns a Better Stack backed logger when ingestion is configured, otherwise
 * `undefined` so Nest keeps its default console logger.
 */
export function createBetterStackLogger(
  env: NodeJS.ProcessEnv,
): LoggerService | undefined {
  const config = resolveBetterStackLogConfig(env);
  if (!config) {
    return undefined;
  }
  return new BetterStackLogger(new BetterStackLogShipper(config));
}

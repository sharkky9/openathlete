import { ConsoleLogger, LogLevel, LoggerService } from '@nestjs/common';

import { resolveBetterStackLogConfig } from './better-stack.config';
import {
  BetterStackLevel,
  BetterStackLogShipper,
} from './better-stack.shipper';

/**
 * Console logger that also ships log records to Better Stack. Console output is
 * kept so platform logs (Railway, Docker) stay complete even when ingestion is
 * unavailable, and only records the console itself emits are shipped: a level
 * disabled locally is never sent to a third party either.
 */
export class BetterStackLogger extends ConsoleLogger {
  constructor(private readonly shipper: BetterStackLogShipper) {
    super();
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(message, ...optionalParams);
    this.ship('info', 'log', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams);
    this.ship('warn', 'warn', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    this.ship('error', 'error', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(message, ...optionalParams);
    this.ship('debug', 'debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(message, ...optionalParams);
    this.ship('trace', 'verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(message, ...optionalParams);
    this.ship('fatal', 'fatal', message, optionalParams);
  }

  private ship(
    level: BetterStackLevel,
    nestLevel: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.isLevelEnabled(nestLevel)) {
      return;
    }

    // Nest passes the context as the last argument and, for errors, a stack
    // trace as the first optional argument.
    const params = [...optionalParams];
    const context =
      typeof params[params.length - 1] === 'string' && params.length > 0
        ? (params.pop() as string)
        : undefined;
    // Nest pads context-bound calls with an `undefined` placeholder when no
    // stack was passed, which would otherwise ship as the string "undefined".
    const stackParts = params.filter(
      (param) => param !== undefined && param !== null,
    );
    const stack =
      stackParts.length > 0 ? stackParts.map(stringify).join('\n') : undefined;

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

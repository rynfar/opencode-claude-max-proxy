import { createConsola, type LogLevel } from "consola";
import { sanitize } from "@/logger/sanitizer";

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  silent: -1,
  fatal: 0,
  error: 0,
  warn: 1,
  log: 2,
  info: 3,
  success: 3,
  debug: 4,
  trace: 5,
  verbose: 5,
};

function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LOG_LEVEL_MAP) return LOG_LEVEL_MAP[raw]!;
  return 3; // info
}

const consola = createConsola({
  level: resolveLogLevel(),
  formatOptions: { date: false },
});

// Wrap all consola methods with sanitizer
for (const key of Object.keys(consola)) {
  const val = consola[key as keyof typeof consola];
  if (typeof val !== "function") continue;
  const fn = val.bind(consola) as (...args: unknown[]) => void;
  (consola as Record<string, unknown>)[key] = (...args: unknown[]) =>
    fn(...args.map(sanitize));
}

export const logger = consola;

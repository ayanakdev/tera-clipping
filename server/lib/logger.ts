import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config';

const logFile = path.join(PATHS.logs, 'app.log');

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level: string, message: string, extra?: unknown): void {
  const detail = extra instanceof Error ? ` ${extra.message}` : extra ? ` ${JSON.stringify(extra)}` : '';
  const line = `[${stamp()}] [${level}] ${message}${detail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    /* logging must never crash the app */
  }
}

export const log = {
  info: (message: string, extra?: unknown) => write('info', message, extra),
  warn: (message: string, extra?: unknown) => write('warn', message, extra),
  error: (message: string, extra?: unknown) => write('error', message, extra),
  debug: (message: string, extra?: unknown) => {
    if (process.env.DEBUG) write('debug', message, extra);
  },
};

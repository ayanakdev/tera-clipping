import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { log } from './logger';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  throwOnError?: boolean;
  maxBuffer?: number;
  label?: string;
}

export class ProcessError extends Error {
  code: number | null;
  stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
    this.stderr = stderr;
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

export function runProcess(file: string, args: string[], opts: RunOptions = {}): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    log.debug(`spawn ${file} ${args.join(' ')}`);
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let aborted = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };

    const outRl = readline.createInterface({ input: child.stdout! });
    const errRl = readline.createInterface({ input: child.stderr! });
    outRl.on('line', (line) => {
      if (stdout.length < max) stdout += `${line}\n`;
      opts.onStdoutLine?.(line);
    });
    errRl.on('line', (line) => {
      if (stderr.length < max) stderr += `${line}\n`;
      opts.onStderrLine?.(line);
    });

    const abortHandler = () => {
      aborted = true;
      killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', abortHandler, { once: true });

    if (opts.timeoutMs) {
      timeout = setTimeout(() => {
        aborted = true;
        killTree(child.pid);
      }, opts.timeoutMs);
    }

    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', abortHandler);
      finish(() => reject(error));
    });

    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', abortHandler);
      const durationMs = Date.now() - started;
      const result: ProcessResult = { code, signal, stdout, stderr, durationMs };
      if (aborted || (opts.signal?.aborted && code !== 0)) {
        finish(() => reject(new DOMException('Process aborted', 'AbortError')));
        return;
      }
      if (code !== 0 && opts.throwOnError !== false) {
        const tail = stderr.trim().split('\n').slice(-12).join('\n');
        finish(() => reject(new ProcessError(`${opts.label || file} exited with code ${code}: ${tail}`, code, stderr)));
        return;
      }
      finish(() => resolve(result));
    });

    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

export function parseFfmpegProgress(line: string, durationSec: number): number {
  if (line.startsWith('out_time_us=')) {
    const us = Number(line.split('=')[1]);
    if (Number.isFinite(us) && durationSec > 0) return Math.min(99, (us / 1_000_000 / durationSec) * 100);
  }
  if (line === 'progress=end') return 100;
  return -1;
}

export { walkFiles } from "./fs-walk.js";
export { scrubSecrets } from "./scrubber.js";
import { scrubSecrets } from "./scrubber.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export interface LogTransport {
  write(entry: LogEntry): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

class ConsoleTransport implements LogTransport {
  private _stream: "stdout" | "stderr";
  constructor(stream: "stdout" | "stderr" = "stdout") { this._stream = stream; }
  write(entry: LogEntry): void {
    const line = scrubSecrets(JSON.stringify(entry));
    if (this._stream === "stderr" || entry.level === "error") process.stderr.write(line + "\n");
    else if (entry.level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }
}

class HumanConsoleTransport implements LogTransport {
  private _stream: "stdout" | "stderr";
  constructor(stream: "stdout" | "stderr" = "stdout") { this._stream = stream; }
  write(entry: LogEntry): void {
    const ts = entry.timestamp.slice(11, 23);
    const msg = scrubSecrets(entry.message);
    const level = entry.level.toUpperCase().padEnd(5);
    const line = `[${ts}] ${level} ${msg}`;
    if (this._stream === "stderr" || entry.level === "error") process.stderr.write(line + "\n");
    else if (entry.level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: "json" | "human";
  output?: string;
  stream?: "stdout" | "stderr";
}

export class Logger {
  private _level: LogLevel;
  private _transports: LogTransport[];

  constructor(options: LoggerOptions = {}) {
    this._level = options.level ?? "info";
    const format = options.format ?? "json";
    const stream = options.stream ?? "stdout";
    this._transports = [];
    this._transports.push(
      format === "human" ? new HumanConsoleTransport(stream) : new ConsoleTransport(stream)
    );
  }

  get level(): LogLevel {
    return this._level;
  }

  set level(lvl: LogLevel) {
    this._level = lvl;
  }

  trace(message: string, context?: Record<string, unknown>): void {
    this.log("trace", message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this._shouldLog(level)) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };
    for (const transport of this._transports) {
      try {
        transport.write(entry);
      } catch {
        // Transport failure is not fatal
      }
    }
  }

  child(context: Record<string, unknown>): Logger {
    // Create a child logger that merges the context into every log entry.
    // Uses a wrapper transport instead of subclassing.
    const parent = this;
    const childTransports: LogTransport[] = this._transports.map(t => ({
      write(entry: LogEntry): void {
        t.write({ ...entry, context: { ...context, ...entry.context } });
      },
      flush: t.flush?.bind(t),
      close: t.close?.bind(t),
    }));
    const child = new Logger({ level: this._level, format: "json" });
    // Override transports with enriched wrappers
    (child as any)._transports = childTransports;
    // Keep level in sync with parent
    Object.defineProperty(child, '_level', {
      get: () => parent._level,
      set: (v: LogLevel) => { parent._level = v; },
    });
    return child;
  }

  private _shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this._level];
  }
}

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}

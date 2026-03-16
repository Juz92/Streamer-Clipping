type LogLevel = "info" | "warn" | "error" | "debug";

interface LogContext {
  jobId?: number;
  module?: string;
  [key: string]: unknown;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, message: string, context?: LogContext) {
  const timestamp = formatTimestamp();
  const prefix = context?.jobId ? `[job:${context.jobId}]` : "";
  const module = context?.module ? `[${context.module}]` : "";
  const extra: Record<string, unknown> = {};
  if (context) {
    for (const [k, v] of Object.entries(context)) {
      if (k !== "jobId" && k !== "module") extra[k] = v;
    }
  }
  const extraStr =
    Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  const line = `${timestamp} ${level.toUpperCase()} ${module}${prefix} ${message}${extraStr}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(module: string) {
  return {
    info: (message: string, context?: Omit<LogContext, "module">) =>
      log("info", message, { ...context, module }),
    warn: (message: string, context?: Omit<LogContext, "module">) =>
      log("warn", message, { ...context, module }),
    error: (message: string, context?: Omit<LogContext, "module">) =>
      log("error", message, { ...context, module }),
    debug: (message: string, context?: Omit<LogContext, "module">) =>
      log("debug", message, { ...context, module }),
  };
}

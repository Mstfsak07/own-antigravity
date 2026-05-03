export type Logger = {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
};

function emit(level: string, message: string, meta?: unknown): void {
  const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  process.stderr.write(`[${new Date().toISOString()}] ${level} ${message}${suffix}\n`);
}

export const logger: Logger = {
  info: (message, meta) => emit("INFO", message, meta),
  warn: (message, meta) => emit("WARN", message, meta),
  error: (message, meta) => emit("ERROR", message, meta)
};

import pino from "pino";

let logger: pino.Logger = pino({ level: "info" });

export function initLogger(level: string): void {
  logger = pino({
    level,
    transport:
      process.stdout.isTTY
        ? { target: "pino/file", options: { destination: 1 } }
        : undefined,
  });
}

export function getLogger(name?: string): pino.Logger {
  return name ? logger.child({ component: name }) : logger;
}

export default logger;

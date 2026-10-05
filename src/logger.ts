/**
 * src/logger.ts — the one pino logger for the whole server.
 *
 * It lives in its own module so that services (WhatsApp, sockets, …) can log
 * without importing `src/index.ts` — importing the entry point would boot the
 * HTTP server, load every AI model and start the device gateway as a side
 * effect, which previously happened whenever a service imported the logger.
 */
import pino, { Logger } from "pino";

const isDev: boolean = process.env.NODE_ENV !== 'production';

export const logger: Logger<never, boolean> = pino({
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    transport: isDev
        ? {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        }
        : undefined,
});

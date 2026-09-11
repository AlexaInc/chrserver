
import pino, { Logger } from "pino";
import { createServer } from 'http';
import {Server} from "./server";
import {WSServer} from "./sockets/wsserver";


const server = new Server({ port: 8000, domain: '0.0.0.0' });

server
    .configureMiddleware()
    .setupRoutes()
    .configureErrorHandling()
    .start();

const wsServer = new WSServer(server.app);
wsServer.setup();
wsServer.listen(server.port)

const isDev: boolean = process.env.NODE_ENV !== 'production';
export const logger: Logger<never, boolean> = pino({
    level: process.env.LOG_LEVEL || 'info',
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


import pino, { Logger } from "pino";
import { createServer } from 'http';
import { Server } from "./server";
import { WSServer } from "./sockets/wsserver";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    loadPlantModel,
    predictPlant,
    loadAllPlantModels
} from "./services/LoadAimodels";

const server = new Server({ port: 8000, domain: '0.0.0.0' });

async function startApp() {
    const models = await loadAllPlantModels('src/models');
    const routeoptions = {
        "models": models,
    }
    server
        .configureMiddleware()
        .setupRoutes(routeoptions)
        .configureErrorHandling()
        .start();

    const wsServer = new WSServer(server.app);
    wsServer.setup();
    wsServer.listen(server.port);
}

startApp();

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
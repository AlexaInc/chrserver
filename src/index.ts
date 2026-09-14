import pino, { Logger } from "pino";
import { Server } from "./server";
import { WSServer } from "./sockets/wsserver";
import { loadAllPlantModels } from "./services/LoadAimodels";
import {WhatsAppService} from "./services/WhatsAppService";

const server = new Server({ port: 8000, domain: '0.0.0.0' });

async function startApp() {
    const models = await loadAllPlantModels('src/models');
    const routeoptions = {
        "models": models,
    }

    server.configureMiddleware();
    server.setupRoutes(routeoptions);
    server.configureErrorHandling();

    const httpServer = server.app.listen(Number(server.port), server.domain, (): void => {
        logger.info(`🚀 Server started successfully at http://${server.domain}:${server.port}`);
    });

    const wsServer = new WSServer(httpServer);
    wsServer.setup();
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


export const initWhatsAppOnStartup = async () => {
    try {
        const wabot = WhatsAppService.getInstance(logger);
        await wabot.init();
        await wabot.start();
        logger.info('WhatsApp service auto-started from existing session.');
    } catch (error) {
        logger.error('Failed to auto-start WhatsApp session:'+ error);
    }
};

// initWhatsAppOnStartup();
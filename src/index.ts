import pino, { Logger } from "pino";
import { Server } from "./server";
import { WSServer } from "./sockets/wsserver";
import { loadAllPlantModels } from "./services/LoadAimodels";
import { WhatsAppService } from "./services/WhatsAppService";
import { startDuckDNSUpdater } from "./services/Duckdns";
import { exec, ChildProcess } from "child_process";
import {config} from "./config/config";
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
        // startDuckDNSUpdater();

        const shouldRunTunnel = process.argv.includes('--tunnel');
        if (shouldRunTunnel) {
            logger.info("Tunnel requested. Starting Cloudflare Named Tunnel...");
            const tunnel: ChildProcess = exec(config.tunnelcmd);

            tunnel.stdout?.on('data', (data) => {
                logger.info(`Cloudflare: ${data.toString().trim()}`);
            });

            tunnel.stderr?.on('data', (data) => {
                logger.error(`Cloudflare Error: ${data.toString().trim()}`);
            });

            process.on('SIGINT', () => {
                tunnel.kill();
                process.exit();
            });
            process.on('SIGTERM', () => {
                tunnel.kill();
                process.exit();
            });
        } else {
            logger.info("Running in local-only mode (No tunnel).");
        }
    });

    const wsServer = new WSServer(httpServer);
    wsServer.setup();
}

startApp();

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
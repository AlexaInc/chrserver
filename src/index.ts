import { Server } from "./server";
import { WSServer } from "./sockets/wsserver";
import { loadAllPlantModels } from "./services/LoadAimodels";
import { WhatsAppService } from "./services/WhatsAppService";
import { WebAppRelease } from "./services/WebAppRelease";
import { PushService } from "./services/PushService";
import { startDuckDNSUpdater } from "./services/Duckdns";
import { exec, ChildProcess } from "child_process";
import {config} from "./config/config";
import { logger } from "./logger";
import { CHRDatabase } from "../db/Sqlight";

export { logger } from "./logger";

const server = new Server({ port: config.port, domain: '0.0.0.0' });

async function startApp() {
    const [models, db] = await Promise.all([
        loadAllPlantModels('src/models'),
        CHRDatabase.open(),
    ]);
    const routeoptions = { models, db };
    server.configureMiddleware();
    server.setupRoutes(routeoptions);
    server.configureErrorHandling();





    WebAppRelease.getInstance().start();





    PushService.getInstance({ store: db });

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

    const wsServer = new WSServer(httpServer, db);
    wsServer.setup();




    const whatsapp = WhatsAppService.getInstance(logger, db);




    wsServer.ownerNotifier = (text, options) => whatsapp.notifyOwners(text, options);

    void whatsapp.autoStart();
}

void startApp();




export const initWhatsAppOnStartup = async () => {
    await WhatsAppService.getInstance(logger).autoStart();
};
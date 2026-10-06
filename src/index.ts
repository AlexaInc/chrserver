import { Server } from "./server";
import { WSServer } from "./sockets/wsserver";
import { loadAllPlantModels } from "./services/LoadAimodels";
import { WhatsAppService } from "./services/WhatsAppService";
import { WebAppRelease } from "./services/WebAppRelease";
import { startDuckDNSUpdater } from "./services/Duckdns";
import { exec, ChildProcess } from "child_process";
import {config} from "./config/config";
import { logger } from "./logger";
import { CHRDatabase } from "../db/Sqlight";
// The logger moved to its own module (src/logger.ts) so services can import it
// without booting this entry point; re-exported here for existing imports.
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

    // Web app: look for a newer chrclient web build and serve the newest copy.
    // Startup is never blocked by this — the server serves whatever build is
    // already in public/ (if any) while the check runs in the background, and
    // an unreachable GitHub leaves that copy in place.
    WebAppRelease.getInstance().start();

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

    // WhatsApp LAST: it needs the database (owner number + link state) and the
    // WSServer instance (robot/pump commands). autoStart() only connects when the
    // DB says the service is enabled AND a session exists on disk — a fresh
    // install stays idle until an account is paired from Settings → WhatsApp.
    const whatsapp = WhatsAppService.getInstance(logger, db);
    void whatsapp.autoStart();
}

void startApp();

/** Kept so existing imports keep working; the app boots the service itself now. */
export const initWhatsAppOnStartup = async () => {
    await WhatsAppService.getInstance(logger).autoStart();
};
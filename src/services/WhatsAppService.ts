import { AuthenticationState, makeWASocket, useMultiFileAuthState, WASocket } from '@alexainc/baileys-mod';
import { Logger, default as P } from "pino";
import { Boom } from '@hapi/boom';
import {logger} from "../index";

export class WhatsAppService {
    private static instance: WhatsAppService | null = null;
    private state!: AuthenticationState;
    private saveCreds!: () => Promise<void>;
    private WaSocket!: WASocket;
    private number: string;
    private sessionPath = 'wasession';

    public constructor(private logger: Logger, number: string) {
        this.logger = logger;
        this.number = number;
    }

    public static getInstance(logger: Logger, number: string = ''): WhatsAppService {
        if (!WhatsAppService.instance) {
            WhatsAppService.instance = new WhatsAppService(logger, number);
        } else if (number && WhatsAppService.instance.number !== number) {
            WhatsAppService.instance.number = number;
        }
        return WhatsAppService.instance;
    }

    public async init(): Promise<void> {
        const authData = await useMultiFileAuthState(this.sessionPath);
        this.state = authData.state;
        this.saveCreds = authData.saveCreds;
        this.logger.debug('WhatsApp session initialized');
    }

    public async start(): Promise<string | void> {
        if (this.WaSocket && this.WaSocket.user) {
            this.logger.info('WhatsApp connection is already active.');
            return;
        }

        return new Promise((resolve, reject) => {
            this.WaSocket = makeWASocket({
                auth: this.state,
                logger:P({ level: "fatal" }),
                printQRInTerminal: false,
            });

            this.WaSocket.ev.on('creds.update', this.saveCreds);

            this.WaSocket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

                    if (statusCode === 515) {
                        this.logger.warn('Received 515 error. Closing connection and retrying with the same session in 3 seconds...');

                        setTimeout(async () => {
                            try {
                                if (this.WaSocket) {
                                    this.WaSocket.end(new Error('Restarting due to 515'));
                                }
                                await this.init();
                                await this.start();
                            } catch (err) {
                                this.logger.debug('Failed to restart session after 515:'+ err);
                            }
                        }, 3000);
                    }
                }

                if (qr && !this.WaSocket.authState.creds.registered) {
                    try {
                        const cleanedNumber = this.number.replace(/\D/g, '');
                        const code = await this.WaSocket.requestPairingCode(cleanedNumber, 'CROPHBOT');
                        this.logger.info(`Pairing Code generated: ${code}`);
                        resolve(code);
                    } catch (error) {
                        reject(error);
                    }
                }
            });
        });
    }
}
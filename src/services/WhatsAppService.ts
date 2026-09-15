import {AuthenticationState, makeWASocket, useMultiFileAuthState, WAMessage, WASocket,proto} from '@alexainc/baileys-mod';
import { Logger, default as P } from "pino";
import { Boom } from '@hapi/boom';
import {logger} from "../index";
export interface ParsedMessage {
    msg: WAMessage;
    msgType: string | null;
    messageContent: any;
    contextInfo: proto.IContextInfo | null | undefined;
    replyInfo: {
        sender: string | null | undefined;
        messageId: string | null | undefined;
        messageText: string;
    } | null;
    text: string;
    command: string | null;
    commandText: string;
    quotedid: string | null | undefined;
    mentionedJids: string[];
    sender: string | null | undefined;
    senderJid: string | null | undefined;
    senderlid: string | null | undefined;
    isGroup: boolean;
    fromMe: boolean | null | undefined;
    jid: string;
    pushName: string | null | undefined;
}
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


    /*
    * #This part taken from alexainc/alexa-v3 by hansaka
    */
    private  parseMessage(msg: WAMessage, AlexaInc?: WASocket): ParsedMessage | {} {
        if (!msg || !msg.message) return {};

        let m: any = msg.message;
        if (m.ephemeralMessage) {
            m = m.ephemeralMessage.message;
        }
        if (m.viewOnceMessage) {
            m = m.viewOnceMessage.message;
        }

        const getContentType = (content: any): string | null => {
            if (!content) return null;
            const keys = Object.keys(content);
            const key = keys.find(
                (k) =>
                    (k === "conversation" || k.endsWith("Message")) &&
                    k !== "senderKeyDistributionMessage" &&
                    k !== "messageContextInfo",
            );
            return key || null;
        };

        const msgType = getContentType(m);
        if (!msgType) return {};

        const messageContent = m[msgType];
        if (!messageContent) return {};

        const contextInfo = messageContent.contextInfo;

        const text =
            messageContent.text ||
            messageContent.caption ||
            messageContent.conversation ||
            "";

        // 4. Handle Reply Info
        const quotedid = contextInfo?.stanzaId;
        let replyInfo: ParsedMessage["replyInfo"] = null;

        if (contextInfo?.quotedMessage) {
            const quoted: any = contextInfo.quotedMessage;
            const quotedType = getContentType(quoted);
            const quotedContent = quotedType ? quoted[quotedType] : null;
            let quotedText = "";

            if (quotedContent) {
                quotedText =
                    quotedContent.text ||
                    quotedContent.caption ||
                    quotedContent.conversation ||
                    "";
            }

            replyInfo = {
                sender: contextInfo.participant,
                messageId: contextInfo.stanzaId,
                messageText: quotedText,
            };
        }

        const remoteJid = msg.key?.remoteJid || "";
        const isGroup = remoteJid.endsWith("@g.us");
        const isDirectMessage = !remoteJid.endsWith("@g.us");

        let rawParticipant: string | null | undefined, rawParticipantAlt: string | null | undefined;

        if (isDirectMessage) {
            rawParticipant = remoteJid;
            rawParticipantAlt = (msg.key as any).remoteJidAlt;
        } else {
            rawParticipant = (msg.key as any).participant;
            rawParticipantAlt = (msg.key as any).participantAlt;
        }

        let finalJid: string | null | undefined = null;
        let finalLid: string | null | undefined = null;

        if (rawParticipant?.endsWith("@lid")) {
            finalLid = rawParticipant;
            finalJid = rawParticipantAlt;
        } else if (rawParticipantAlt?.endsWith("@s.whatsapp.net")) {
            finalJid = rawParticipantAlt;
            finalLid = rawParticipant;
        } else {
            finalJid = rawParticipant;
            finalLid = rawParticipantAlt;
        }
        const sender = finalLid;

        const prefix = /^[./!]/;
        const body = text.trim().split(/ +/);
        const commandWithPrefix = body.shift()?.toLowerCase() || "";

        let command: string | null = null;
        let commandText = text;

        if (prefix.test(commandWithPrefix)) {
            command = commandWithPrefix.slice(1);
            commandText = body.join(" ");
        }

        return {
            msg,
            msgType,
            messageContent,
            contextInfo,
            replyInfo,
            text,
            command,
            commandText,
            quotedid,
            mentionedJids: contextInfo?.mentionedJid || [],
            sender,
            senderJid: finalJid,
            senderlid: finalLid,
            isGroup,
            fromMe: msg.key?.fromMe,
            jid: remoteJid,
            pushName: msg.pushName,
        };
    }

    //end of taken part



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
            this.WaSocket.ev.on('messages.upsert',async (m)=>{
                const { messages, type } = m;
                if (!messages?.length) return;

                const msg = messages[0];
                const jid = msg.key.remoteJid;
                const p: ParsedMessage = (await this.parseMessage(msg, this.WaSocket)) as ParsedMessage;
                logger.debug(p.senderlid)
            })
        });
    }
}
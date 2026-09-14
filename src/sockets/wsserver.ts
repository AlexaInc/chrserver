import { Server, Socket } from "socket.io";
import http from "http";
import { logger } from "../index";
import { sessions } from "../server";
import { config } from "../config/config";

export interface RobotMessage<T = any> {
    Type: string;
    Message: T;
}

export interface RobotMessageContent {
    moisture: {
        raw_value: number;
        moisture_percent: number;
    };
    temperature: number;
    humidity: number;
}

export class WSServer {
    public io: Server;
    constructor(httpServer: http.Server) {
        this.io = new Server(httpServer, {
            cors: {
                origin: true,
                methods: ['GET', 'POST'],
                credentials: true
            },
            transports: ['polling', 'websocket']
        });
    }

    public setup(): this {
        this.io.use((socket: Socket, next) => {
            const role = socket.handshake.auth?.role || socket.handshake.query?.role;

            if (role === "authorized") {
                const token = socket.handshake.auth?.token;
                const ADMIN_USERNAME = config.ADMIN_USERNAME;
                const mappedUser = sessions.get(token);

                if (!mappedUser || mappedUser !== ADMIN_USERNAME) {
                    logger.warn(`Unauthorized WebSocket connection rejected: ${socket.id}`);
                    return next(new Error("Authentication failed: Invalid or expired token"));
                }
            } else if (role === "esp_32") {
                // sspautj
                return next();
            } else {
                logger.warn(`Unknown or missing role rejected: ${socket.id} (Role: ${role})`);
                return next(new Error("Authentication failed: Invalid or missing role"));
            }

            next();
        });

        this.io.on('connection', (socket: Socket) => {
            this.userhandler(socket);
        });
        return this;
    }

    private userhandler(socket: Socket): void {
        const role = socket.handshake.auth?.role || socket.handshake.query?.role;

        switch (role) {
            case "esp_32": {
                socket.join('esp_32_room');
                logger.info(`ESP 32 connected: ${socket.id}`);
                this.handleClientA(socket);
                break;
            }
            case "authorized": {
                logger.info(`Authorized Client connected: ${socket.id}`);
                this.handleAuthorizedClient(socket);
                break;
            }
            default: {
                socket.disconnect(true);
                break;
            }
        }
        this.handleDisconnect(socket);
    }

    private handleClientA(socket: Socket): void {
        socket.on('message.upsert', (data: RobotMessage<RobotMessageContent>) => {
            logger.debug(JSON.stringify(data, null, 2));
            logger.info(`Broadcasting message from esp32 (${socket.id})`);
            this.io.emit('message.upsert', data);
        });
    }

    private handleAuthorizedClient(socket: Socket): void {
        socket.on('control_message', async (data: any, callback) => {
            logger.info(`Control message from ${socket.id} sent to esp32`);

            this.io.to('esp_32_room').emit('control_command', {
                from: socket.id,
                command: data,
            });
            logger.info(data);
            if (data.action === "change_mode") {
                try {
                    const isProcessSuccessful = true;
                    if (isProcessSuccessful) {
                        if (typeof callback === 'function') {
                            callback({ success: true, message: 'Mode changed successfully' });
                        }
                    } else {
                        if (typeof callback === 'function') {
                            callback({ success: false, reason: 'System is busy or invalid mode.' });
                        }
                    }
                } catch (error: any) {
                    if (typeof callback === 'function') {
                        callback({ success: false, reason: error.message });
                    }
                }
            }
        });
    }

    private handleDisconnect(socket: Socket): void {
        socket.on('disconnect', () => {
            logger.info(`Disconnected ${socket.id}`);
        });
    }
}
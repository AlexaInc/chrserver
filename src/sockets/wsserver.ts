import { Server, Socket } from "socket.io";
import { Express } from "express";
import http from "http";
import { logger } from "../index";

export class WSServer {
    public io: Server;
    public server: http.Server;

    constructor(app: Express) {
        this.server = http.createServer(app);
        this.io = new Server(this.server, {
            cors: {
                origin: true,
                methods: ['GET', 'POST'],
            }
        });
    }

    public setup(): this {
        this.io.on('connection', (socket: Socket) => {
            this.userhandler(socket);
            // logger.info(socket)
        });

        return this;
    }

    private userhandler(socket: Socket): void {
        const token =socket.handshake.auth.token;

        const role = socket.handshake.auth?.role || socket.handshake.query?.role || token;

        switch (role) {
            case "esp_32":{
                socket.join('esp_32_room');
                logger.info(`ESP 32 connected: ${socket.id}`);
                this.handleClientA(socket);
                break;
            }
            case "authorized":{
                logger.info(`Authorized Client connected: ${socket.id}`);
                this.handleAuthorizedClient(socket);
                break;
            }default:{
                logger.info(`Client connected: ${socket.id}`);
                break
            }

        }


        this.handleDisconnect(socket);
    }

    //  msg from esp
    private handleClientA(socket: Socket): void {
        socket.on('esp_32_message', (data: unknown) => {
            logger.info(`Broadcasting message from esp32 (${socket.id})`);

            // bc msg to connected clits
            this.io.emit('broadcast_from_a', {
                sender: socket.id,
                payload: data,
            });
        });
    }

    private handleAuthorizedClient(socket: Socket): void {
        socket.on('control_message', (data: unknown) => {
            logger.info(`Control message from ${socket.id} sent to esp32`);

            // Routes message ONLY to sockets inside 'esp32'
            this.io.to('esp_32_room').emit('control_command', {
                from: socket.id,
                command: data,
            });
        });
    }

    private handleDisconnect(socket: Socket): void {
        socket.on('disconnect', () => {
            logger.info(`Disconnected ${socket.id}`);
        });
    }

    public listen(port: number, callback?: () => void): void {
        this.server.listen(port, callback);
    }
}
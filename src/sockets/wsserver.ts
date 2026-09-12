import { Server, Socket } from "socket.io";
import { Express } from "express";
import http from "http";
import { logger } from "../index";



//costom dtatypes(interfacess defin)

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
//clases
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
        socket.on('message.upsert', (data: RobotMessage<RobotMessageContent>) => {
            logger.debug(JSON.stringify(data,null,2));
            logger.info(`Broadcasting message from esp32 (${socket.id})`);
            switch (data.Type){
                case "env_info":{
                    //////handle env info             // bc msg to connected clits
                                this.io.emit('env_info', {
                                    sender: socket.id,
                                    event: data,
                                });

                    break;
                }
                case "location":{
                    logger.debug(JSON.stringify(data,null,2));
                    //mapprocesorgpsnot created yet
                    break;
                }
            }

        });

    }

    private handleAuthorizedClient(socket: Socket): void {
        socket.on('control_message', (data: unknown) => {
            logger.info(`Control message from ${socket.id} sent to esp32`);

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
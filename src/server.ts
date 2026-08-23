import express, { Response, Request, Express, NextFunction } from 'express';
import { logger } from "./index";

export interface ServerConfig {
    port: string | number;
    domain: string;
}

export class Server {
    app: Express;
    port: string | number;
    domain: string;

    constructor({ port, domain }: ServerConfig) {
        this.app = express();
        this.port = port;
        this.domain = domain;
    }

    configureMiddleware(): this {
        // Increased JSON payload limit slightly to accommodate image buffers if passed via JSON
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        return this;
    }

    setupRoutes(): this {
        this.app.post("/auth/login", (req: Request, res: Response, next: NextFunction):void => {
            try {
                logger.info("login request");
                logger.info(req.body);
                res.status(200).send({ "ok": true });
            } catch (error) {
                next(error);
            }
        });

        this.app.post("/api/images/upload", (req: Request, res: Response, next: NextFunction):Response<any, Record<string, any>> | undefined => {
            try {
                logger.info("upload request");

                const file = req?.body?.file;

                // 1. Check if file object exists
                if (!file) {
                    return res.status(400).send({
                        "ok": false,
                        "error": "Bad Request",
                        "message": "Missing file payload in request body"
                    });
                }



                // 2. Validate file type
                const validTypes = ["image/jpg", "image/png", "image/jpeg"];
                if (!validTypes.includes(file.type)) {
                    return res.status(415).send({
                        "ok": false,
                        "error": "Unsupported Media Type",
                        "message": "Invalid file type, only support png or jpg"
                    });
                }

                // 3. Validate buffer existence
                if (!file.buffer) {
                    return res.status(400).send({
                        "ok": false,
                        "error": "Bad Request",
                        "message": "Buffer is empty"
                    });
                }

                logger.info("File buffer received successfully");

                // 4. Send success response
                return res.status(200).send({
                    "ok": true,
                    "message": "Image uploaded and processed successfully"
                });

            } catch (error) {
                // Forward any unexpected errors to the global error handler
                next(error);
            }
        });

        this.app.post('/api/robot/command',(req: Request, res: Response, next: NextFunction):void => {
            logger.info("robot request");
            logger.info(`${JSON.stringify(req)}`);
            res.status(200).send({ "ok": true });
        })

        return this;
    }

    // Global Error Handling Middleware (must be registered AFTER routes)
    configureErrorHandling(): this {
        this.app.use((err: Error, req: Request, res: Response, next: NextFunction):void => {
            // Fix: Combine message and stack trace into a single string for the logger
            logger.error(`Unhandled error: ${err.message} \nStack: ${err.stack}`);

            res.status(500).send({
                "ok": false,
                "error": "Internal Server Error",
                "message": process.env.NODE_ENV === 'production'
                    ? "An unexpected error occurred"
                    : err.message
            });
        });
        return this;
    }
    start(): void {

        const server= this.app.listen(Number(this.port), this.domain, ():void => {
            logger.info(`🚀 Server started successfully at http://${this.domain}:${this.port}`);
        });

        // Handle server startup errors (e.g., Port already in use)
        server.on('error', (error: NodeJS.ErrnoException) => {
            logger.error(`Server startup error: ${error.message}`);
            if (error.code === 'EADDRINUSE') {
                logger.error(`Port ${this.port} is already in use. Please use a different port.`);
            }
        });
    }
}
import express, { Response, Request, Express, NextFunction } from 'express';
import { logger } from "./index";
import multer from 'multer';
import { Sequential } from '@tensorflow/tfjs';
import {
    predictPlant
} from "./services/LoadAimodels";
export interface PlantModelData {
    plant: string;
    model: Sequential;
    classes: string[];

}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
export interface ServerConfig {
    port:  number;
    domain: string;
}

export class Server {
    app: Express;
    public port:  number;
    domain: string;

    models :PlantModelData | null;

    constructor({ port, domain }: ServerConfig) {
        this.app = express();
        this.port = port;
        this.models = null ;
        this.domain = domain;
    }

    configureMiddleware(): this {
        // Increased JSON payload limit slightly to accommodate image buffers if passed via JSON
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        return this;
    }

    setupRoutes(options:any ): this {
        this.models = options["models"];
        this.app.post("/auth/login", (req: Request, res: Response, next: NextFunction):void => {
            try {
                logger.info("login request");
                logger.info(req.body);
                res.status(200).send({ "ok": true });
            } catch (error) {
                next(error);
            }
        });

        this.app.post(
            "/api/images/upload",
            upload.single('file'),
            async (req: Request, res: Response, next: NextFunction): Promise<Response<any, Record<string, any>> | undefined> => {
                try {
                    logger.debug("upload request");

                    const file = req.file;
                    logger.debug(req.body.plant)
                    const otherData = req.body.someTextField;

                    if (!file) {
                        return res.status(400).send({
                            "ok": false,
                            "error": "Bad Request",
                            "message": "Missing file payload in request body"
                        });
                    }

                    const validTypes = ["image/jpg", "image/png", "image/jpeg"];
                    if (!validTypes.includes(file.mimetype)) {
                        return res.status(415).send({
                            "ok": false,
                            "error": "Unsupported Media Type",
                            "message": "Invalid file type, only support png or jpg"
                        });
                    }

                    if (!file.buffer) {
                        return res.status(400).send({
                            "ok": false,
                            "error": "Bad Request",
                            "message": "Buffer is empty"
                        });
                    }
                    if (!this.models) {
                        return res.status(500).send({
                            "ok": false,
                            "message": "Internal Server Error",
                            "reason": "models not loaded yet"
                        });
                    }
                    if(!req.body.plant){
                        return res.status(400).send({
                            "ok": false,
                            "error": "Bad Request",
                            "reason": "Missing plant name payload in request body"
                        })
                    }
                    const found = (this.models as unknown as PlantModelData[]).find((item) => item.plant === req.body.plant);

                    if (!found) {
                        return res.status(404).send({
                            "ok": false,
                            "message": "Not Found",
                            "reason": "apple model not found"
                        });
                    }


                    const predictions = await predictPlant(found, file.buffer, 5);
                    return res.status(200).send({
                        "ok": true,
                        "message": "Image uploaded and processed successfully",
                        "result": predictions
                    });

                } catch (error) {
                    next(error);
                }
            }
        );

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
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: process.env.ENV_FILE || path.resolve(process.cwd(), ".env") });

export interface EnvConfig {
    port: number;
    ADMIN_USERNAME: string;
    ADMIN_PASS: string;
    Domain: string;
    tunnelcmd: string;
    ROBOT_TOKEN: string;
    PUMP_TOKEN: string;
    DuckdnsToken: string;
    jwt_secret: string;
}

export const config: EnvConfig = {
    port: Number(process.env.PORT) || 8000,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || "Administrator",
    ADMIN_PASS: process.env.ADMIN_PASSWORD || "@dm!nchr",
    Domain: process.env.DOMAIN || "",
    DuckdnsToken: process.env.DUCKDNS_TOKEN || "",
    tunnelcmd: process.env.TUNNEL_CMD || "",
    ROBOT_TOKEN: process.env.ROBOT_TOKEN || "change-this-robot-token",
    PUMP_TOKEN: process.env.PUMP_TOKEN || "change-this-pump-token",
    jwt_secret: process.env.JWT_SECRET || "change-this-session-secret",
};

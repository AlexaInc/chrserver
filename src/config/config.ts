import dotenv from "dotenv";
import path from "path";

// Project root .env (matches .env.example at the repo root, and the README's
// documented configuration steps). Previously this resolved to src/config/.env,
// which meant a normal `.env` at the project root was silently ignored and the
// server always fell back to hardcoded defaults (wrong ADMIN_*/ROBOT_TOKEN/
// PUMP_TOKEN — a real client/server/hardware wiring bug: the client would log
// in with the placeholder admin password and devices with placeholder tokens
// while the "configured" .env was never actually read).
dotenv.config({
    path: process.env.ENV_FILE || path.resolve(__dirname, "..", "..", ".env")
});
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

if (process.env.NODE_ENV !== "production") {
    // Redact secrets — never print tokens/passwords, even in dev logs.
    console.log({ ...config, ADMIN_PASS: "***", ROBOT_TOKEN: "***", PUMP_TOKEN: "***", jwt_secret: "***" });
}
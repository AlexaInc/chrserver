import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

export interface envconfig {
    port: number;
    ADMIN_USERNAME: string;
    ADMIN_PASS: string;
    jwt_secret: string;
}

export const config: envconfig = {
    port: Number(process.env.PORT) || 8000,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'Administrator',
    ADMIN_PASS: process.env.ADMIN_PASSWORD || '@dm!nchr',
    jwt_secret: process.env.JWT_SECRET || 'suprsecret1235kr',
};
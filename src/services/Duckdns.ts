const INTERVAL_MS = 5 * 60 * 1000;
import {config} from "../config/config";
const DOMAIN: string = config.Domain;
const TOKEN: string = config.DuckdnsToken;
// console.log(config)
import {logger} from "../index";
async function updateDuckDNS(): Promise<void> {
    const url = `https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}`;

    try {
        const response = await fetch(url);
        const body: string = await response.text();

        if (body.trim() === 'OK') {
            logger.debug(`[${new Date().toLocaleTimeString()}] DuckDNS Updated`);
        } else {
            logger.error(`DuckDNS Update Err: ${body}`);
        }
    } catch (error: any) {
        logger.error('Network error:', error.message);
    }
}

export function startDuckDNSUpdater(): void {
    updateDuckDNS();
    setInterval(updateDuckDNS, INTERVAL_MS);
}
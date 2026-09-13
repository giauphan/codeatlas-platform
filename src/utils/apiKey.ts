import * as crypto from "crypto";
import { logger } from "./logger.js";

export const DEFAULT_API_KEY_PEPPER = 'codeatlas-api-key-pepper-v1';

let warnedDefaultPepper = false;

export function getApiKeyPepper(): string {
  if (!process.env.API_KEY_PEPPER && !warnedDefaultPepper) {
    warnedDefaultPepper = true;
    logger.warn("API_KEY_PEPPER is unset. Using compatibility fallback; configure a secret pepper for production.");
  }
  return process.env.API_KEY_PEPPER || DEFAULT_API_KEY_PEPPER;
}

export async function hashApiKey(apiKey: string): Promise<string> {
  const pepper = getApiKeyPepper();
  return new Promise<string>((resolve, reject) => {
    crypto.pbkdf2(apiKey, Buffer.from(pepper, 'utf8'), 100000, 64, 'sha256', (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

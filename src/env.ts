import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Support both local development (src/env.ts) and compiled package (dist/src/env.js)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

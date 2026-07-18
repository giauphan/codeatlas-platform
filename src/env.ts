import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import * as path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Support both local development (src/env.ts) and compiled package (dist/src/env.js)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();
// tsx watch restart test 1784358355
// tsx watch retry test 1784358505

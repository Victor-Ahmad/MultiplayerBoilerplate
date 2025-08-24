// Copies client/dist to server/client-dist so the server can serve it.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const src = resolve(__dirname, "../dist");
const dest = resolve(__dirname, "../../server/client-dist");

if (!existsSync(src)) {
  console.error("Build output not found. Did you run `vite build`?");
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied client build -> ${dest}`);

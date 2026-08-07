import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDirectory = resolve(projectRoot, "public/vendor");

await mkdir(vendorDirectory, { recursive: true });
await copyFile(
  resolve(projectRoot, "node_modules/qrcode-generator/qrcode.js"),
  resolve(vendorDirectory, "qrcode.js")
);

console.log("Prepared browser dependencies in public/vendor.");

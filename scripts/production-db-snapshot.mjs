import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeD1Export } from "./production-db-safety.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotDirectory = resolve(projectRoot, ".wrangler/production-snapshot");
const backupDirectory = resolve(projectRoot, ".wrangler/production-snapshot.previous");
const [operation, inputPath] = process.argv.slice(2);

if (operation === "normalize") {
  const exportFile = resolve(inputPath);
  await writeFile(exportFile, normalizeD1Export(await readFile(exportFile, "utf8")), { mode: 0o600 });
} else if (operation === "validate") {
  const payload = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  const result = Array.isArray(payload) ? payload[0] : null;
  if (!result?.success || !Array.isArray(result.results) || result.results.length) {
    throw new Error("The local snapshot failed its foreign-key validation.");
  }
} else if (operation === "promote") {
  const stagingDirectory = resolve(inputPath);
  if (stagingDirectory !== resolve(projectRoot, ".wrangler/production-snapshot.next")) throw new Error("Refusing to promote an unexpected directory.");
  await rm(backupDirectory, { recursive: true, force: true });
  let previousSnapshotMoved = false;
  try { await rename(snapshotDirectory, backupDirectory); previousSnapshotMoved = true; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { await rename(stagingDirectory, snapshotDirectory); }
  catch (error) {
    if (previousSnapshotMoved) await rename(backupDirectory, snapshotDirectory);
    throw error;
  }
  await rm(backupDirectory, { recursive: true, force: true });
} else {
  throw new Error("Use normalize, validate, or promote with the expected local file or directory.");
}

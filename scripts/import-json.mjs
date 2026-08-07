import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: npm run import:json -- <state.json> --url <private-tempo-url>");
  console.error("Example: npm run import:json -- ./tempo-state.json --url http://localhost:8787/p/<capability>");
  process.exit(1);
}

const args = process.argv.slice(2);
const fileArg = args.find(arg => !arg.startsWith("--"));
const urlIndex = args.indexOf("--url");
const targetArg = urlIndex >= 0 ? args[urlIndex + 1] : process.env.TEMPO_PRIVATE_URL;
if (!fileArg || !targetArg) usage("A JSON file and private Tempo URL are required.");

let target;
try { target = new URL(targetArg); } catch { usage("The private Tempo URL is invalid."); }
const capability = /^\/p\/([A-Za-z0-9_-]{43})\/?$/.exec(target.pathname)?.[1];
if (!capability) usage("The URL must contain a valid /p/<capability> path.");

const filePath = resolve(fileArg);
const source = await readFile(filePath, "utf8").catch(error => usage(`Could not read ${filePath}: ${error.message}`));
let state;
try { state = JSON.parse(source); } catch (error) { usage(`The file is not valid JSON: ${error.message}`); }
if (!state || typeof state !== "object" || Array.isArray(state)) usage("The JSON root must be a Tempo state object.");

const headers = { Authorization: `Bearer ${capability}` };
const bootstrapResponse = await fetch(new URL("/api/bootstrap", target), { headers });
const bootstrap = await bootstrapResponse.json().catch(() => ({}));
if (!bootstrapResponse.ok) usage(bootstrap.error?.message || `Bootstrap failed (${bootstrapResponse.status}).`);
if (!bootstrap.data?.empty) usage("The target private area is not empty. JSON import is intentionally refused.");

const response = await fetch(new URL("/api/state", target), {
  method: "PUT",
  headers: { ...headers, "content-type": "application/json", "If-Match": `"${bootstrap.revision}"` },
  body: JSON.stringify(state)
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) usage(payload.error?.message || `Import failed (${response.status}).`);

console.log(`Imported ${filePath}`);
console.log(`Target: ${target.origin}${target.pathname}`);
console.log(`Revision: ${payload.revision}`);
console.log("Imported state:", {
  timers: payload.data?.timers?.length || 0,
  habits: payload.data?.widgets?.length || 0,
  foods: payload.data?.foods?.length || 0,
  meals: payload.data?.meals?.length || 0,
  workouts: payload.data?.strength?.workouts?.length || 0,
  mesocycles: payload.data?.strength?.mesocycles?.length || 0
});

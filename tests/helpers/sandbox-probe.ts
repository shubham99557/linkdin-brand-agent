// Runs in a worker thread (P2-03b): installs the PDF reader's guards, then tries every kind of network and file
// access, both through the CommonJS module objects and through ES module named imports. Reports what happened.
import { parentPort } from "node:worker_threads";
import fs, { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { fileURLToPath } from "node:url";
import { installSandboxGuards } from "../../services/api/src/pdf-sandbox.ts";

const self = fileURLToPath(import.meta.url);
const attempts = installSandboxGuards();
const results: Record<string, string> = {};
const tryIt = async (name: string, f: () => unknown) => {
  try { await f(); results[name] = "ALLOWED"; } catch (e) { results[name] = (e as Error).message; }
};
await tryIt("fetch", () => fetch("http://127.0.0.1:59999/"));
await tryIt("WebSocket", () => new WebSocket("ws://127.0.0.1:59999/"));
await tryIt("http.get", () => new Promise((resolve, reject) => { http.get("http://127.0.0.1:59999/", resolve).on("error", reject); }));
await tryIt("net.connect", () => new Promise((resolve, reject) => { net.connect(59999, "127.0.0.1", () => resolve(null)).on("error", reject); }));
await tryIt("dns.lookup", () => dns.promises.lookup("example.com"));
await tryIt("fs.readFileSync", () => fs.readFileSync(self));
await tryIt("readFileSync (ESM import)", () => readFileSync(self));
await tryIt("readFile (ESM import of fs/promises)", () => readFile(self));
await tryIt("fs.openSync", () => fs.openSync(self, "r"));
await tryIt("fs.createReadStream", () => fs.createReadStream(self));
parentPort!.postMessage({ results, attempts });

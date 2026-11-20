// P2-03b / ADR-032 condition 2: inside the PDF worker thread, nothing may open a network connection or read a file.
// PDF.js is configured with no URLs (fonts, character maps, colour profiles, decoders), so it has no reason to; these
// guards make sure, and record any attempt so the API can log it as a security event.
//
// Call installSandboxGuards() only in the PDF worker thread, after PDF.js has been loaded (loading a module reads
// files). Built-in modules are separate per thread, so the API thread is unaffected.

export function installSandboxGuards(): string[] {
  const attempts: string[] = [];
  const deny = (what: string): never => {
    attempts.push(what);
    throw new Error(`blocked in the PDF reader: ${what}`);
  };
  const g = globalThis as Record<string, unknown>;
  g.fetch = async () => deny("fetch");
  g.WebSocket = class { constructor() { deny("WebSocket"); } };

  const net = process.getBuiltinModule("node:net");
  net.Socket.prototype.connect = function connect() { return deny("net.connect"); } as never;   // covers http, https, tls
  const dns = process.getBuiltinModule("node:dns");
  dns.lookup = (() => deny("dns.lookup")) as never;
  dns.promises.lookup = (async () => deny("dns.lookup")) as never;

  const fs = process.getBuiltinModule("node:fs");
  fs.readFile = (() => deny("fs.readFile")) as never;
  fs.readFileSync = (() => deny("fs.readFileSync")) as never;
  fs.open = (() => deny("fs.open")) as never;
  fs.openSync = (() => deny("fs.openSync")) as never;
  fs.createReadStream = (() => deny("fs.createReadStream")) as never;
  const fsp = process.getBuiltinModule("node:fs/promises");   // the same object as fs.promises
  fsp.readFile = (async () => deny("fs.promises.readFile")) as never;
  fsp.open = (async () => deny("fs.promises.open")) as never;
  // ES module imports of built-ins (import { readFileSync } from "node:fs") see the guards too.
  process.getBuiltinModule("node:module").syncBuiltinESMExports();
  return attempts;
}

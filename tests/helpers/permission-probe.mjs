// P2-03b: started by a test with exactly the PDF reader's Node options (pdfReaderExecArgv) but WITHOUT the
// JavaScript guards, to show that the Node permission model alone already refuses network, file, process, thread
// and eval access. Plain JavaScript (.mjs) so Node does not need to read any package.json to run it.
// argv: [secretFile, otherFile]
import fs from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

const [secretFile, otherFile] = process.argv.slice(2);
const results = {};
const tryIt = async (name, f) => {
  try { await f(); results[name] = "ALLOWED"; } catch (e) {
    const root = e.cause ?? e;          // fetch wraps the underlying error as its cause
    results[name] = `${root.code ?? root.name}: ${root.message}`.slice(0, 200);
  }
};
await tryIt("read .env", () => fs.readFileSync(secretFile));
await tryIt("read other repo file", () => fs.readFileSync(otherFile));
await tryIt("write a file", () => fs.writeFileSync(`${otherFile}.probe`, "x"));
await tryIt("fetch", () => fetch("http://127.0.0.1:59999/"));
await tryIt("net.connect", () => new Promise((resolve, reject) => { net.connect(59999, "127.0.0.1", resolve).on("error", reject); }));
await tryIt("child process", () => { const r = spawnSync(process.execPath, ["-v"]); if (r.error) throw r.error; });
await tryIt("worker thread", () => new Worker("process.exit(0)", { eval: true }));
await tryIt("eval", () => eval("1 + 1"));
await tryIt("new Function", () => new Function("return 1")());
process.send({ results, env: Object.keys(process.env) });
process.disconnect();

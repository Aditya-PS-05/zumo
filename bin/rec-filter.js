#!/usr/bin/env node
import { createWriteStream } from "node:fs";

const destination = process.argv[2];
if (!destination) {
  console.error("usage: rec-filter.js <recording.jsonl>");
  process.exit(2);
}

const output = createWriteStream(destination, { flags: "a", mode: 0o600 });
process.stdin.on("data", (chunk) => {
  const row = JSON.stringify({ t: Date.now(), d: Buffer.from(chunk).toString("base64") });
  if (!output.write(`${row}\n`)) process.stdin.pause();
});
output.on("drain", () => process.stdin.resume());
process.stdin.on("end", () => output.end());
process.stdin.on("error", () => output.end());
output.on("error", (error) => {
  console.error(`zumo recorder: ${error.message}`);
  process.exit(1);
});

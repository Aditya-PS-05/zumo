#!/usr/bin/env node
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RECORDINGS_DIR } from "../src/config.js";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 1024 ** 3;

if (!existsSync(RECORDINGS_DIR)) process.exit(0);

const cutoff = Date.now() - MAX_AGE_MS;
let files = readdirSync(RECORDINGS_DIR)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => {
    const path = join(RECORDINGS_DIR, name);
    return { path, ...statSync(path) };
  });

for (const file of files.filter((item) => item.mtimeMs < cutoff)) {
  rmSync(file.path, { force: true });
}

files = files.filter((item) => item.mtimeMs >= cutoff).sort((a, b) => a.mtimeMs - b.mtimeMs);
let total = files.reduce((sum, item) => sum + item.size, 0);
for (const file of files) {
  if (total <= MAX_TOTAL_BYTES) break;
  rmSync(file.path, { force: true });
  total -= file.size;
}

#!/usr/bin/env node
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RECORDINGS_DIR, UPLOADS_DIR } from "../src/config.js";

function prune(directory, accept, maxAgeMs, maxTotalBytes) {
  if (!existsSync(directory)) return;
  const cutoff = Date.now() - maxAgeMs;
  let files = readdirSync(directory)
    .filter(accept)
    .map((name) => {
      const path = join(directory, name);
      return { path, ...statSync(path) };
    })
    .filter((item) => item.isFile());

  for (const file of files.filter((item) => item.mtimeMs < cutoff)) rmSync(file.path, { force: true });

  files = files.filter((item) => item.mtimeMs >= cutoff).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, item) => sum + item.size, 0);
  for (const file of files) {
    if (total <= maxTotalBytes) break;
    rmSync(file.path, { force: true });
    total -= file.size;
  }
}

prune(RECORDINGS_DIR, (name) => name.endsWith(".jsonl"), 7 * 24 * 60 * 60 * 1000, 1024 ** 3);
prune(UPLOADS_DIR, () => true, 24 * 60 * 60 * 1000, 256 * 1024 ** 2);

#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// New installs use ~/.zumo; an existing ~/.port23 install is reused so re-running setup
// after the rename keeps the same config, VAPID keys, and subscriptions. ZUMO_HOME
// (or the legacy PORT23_HOME) overrides both.
const legacyHome = join(homedir(), ".port23");
const defaultHome = join(homedir(), ".zumo");
const zumoHome = process.env.ZUMO_HOME || process.env.PORT23_HOME
  || (existsSync(defaultHome) ? defaultHome : existsSync(legacyHome) ? legacyHome : defaultHome);
const configPath = join(zumoHome, "config.json");
const hookPath = join(zumoHome, "zumo-hook.sh");
const userUnitDir = join(homedir(), ".config", "systemd", "user");
const claudeSettingsPath = join(homedir(), ".claude", "settings.json");

function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${path} is not valid JSON: ${error.message}`); }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.zumo-tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function assertPrerequisites() {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("zumo setup supports Linux and macOS only. On Windows, run zumo inside WSL2.");
  }
  for (const command of ["node", "tmux", "claude"]) {
    try { execFileSync("which", [command], { stdio: "ignore" }); }
    catch { throw new Error(`${command} is required but was not found on PATH`); }
  }
  const version = execFileSync("tmux", ["-V"], { encoding: "utf8" }).match(/([0-9]+(?:\.[0-9]+)?)/)?.[1];
  if (!version || Number(version) < 3.1) throw new Error(`tmux >= 3.1 is required (found ${version || "unknown"})`);
}

function configureZumo() {
  mkdirSync(join(zumoHome, "pending"), { recursive: true });
  mkdirSync(join(zumoHome, "recordings"), { recursive: true });
  const current = readJson(configPath);
  const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  const vapid = current.vapid?.publicKey && current.vapid?.privateKey
    ? current.vapid
    : { ...webpush.generateVAPIDKeys(), subject: "mailto:zumo@localhost" };
  const config = {
    port: 7323,
    repoRoots: [join(homedir(), "my-work")],
    activityWindowMs: 3000,
    claudeBin,
    ...current,
    vapid,
  };
  writeJson(configPath, config);
  return config;
}

function installHook() {
  copyFileSync(join(repoRoot, "bin", "zumo-hook.sh"), hookPath);
  chmodSync(hookPath, 0o755);

  const settings = readJson(claudeSettingsPath);
  settings.hooks ||= {};
  const command = shellQuote(hookPath);
  for (const event of ["Notification", "Stop"]) {
    settings.hooks[event] ||= [];
    const installed = settings.hooks[event].some((group) =>
      group?.hooks?.some((hook) => hook?.type === "command" && /(?:zumo|port23)-hook\.sh/.test(String(hook.command))),
    );
    if (!installed) {
      settings.hooks[event].push({
        matcher: "",
        hooks: [{ type: "command", command, timeout: 3 }],
      });
    }
  }
  writeJson(claudeSettingsPath, settings);
}

function installUnits(config) {
  return process.platform === "darwin" ? installLaunchdAgents(config) : installSystemdUnits(config);
}

function plistEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function installLaunchdAgents(config) {
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  const node = process.execPath;
  const logPath = join(zumoHome, "zumo.log");

  const plist = (label, programArgs, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs.map((arg) => `    <string>${plistEscape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ZUMO_HOME</key><string>${plistEscape(zumoHome)}</string>
    <key>PATH</key><string>${plistEscape(process.env.PATH || "/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
${extra}</dict>
</plist>
`;

  const daemonLabel = "com.zumo.daemon";
  const daemonPlist = plist(daemonLabel, [node, join(repoRoot, "index.ts")], [
    `  <key>WorkingDirectory</key><string>${plistEscape(repoRoot)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>StandardOutPath</key><string>${plistEscape(logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${plistEscape(logPath)}</string>`,
    "",
  ].join("\n"));

  const retentionLabel = "com.zumo.retention";
  const retentionPlist = plist(retentionLabel, [node, join(repoRoot, "bin", "retention.js")], [
    "  <key>StartCalendarInterval</key>",
    "  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>",
    "",
  ].join("\n"));

  for (const [label, contents] of [[daemonLabel, daemonPlist], [retentionLabel, retentionPlist]]) {
    const path = join(agentsDir, `${label}.plist`);
    writeFileSync(path, contents);
    spawnSync("launchctl", ["unload", path], { stdio: "ignore" }); // ignore: not loaded yet
    const load = spawnSync("launchctl", ["load", "-w", path], { stdio: "inherit" });
    if (load.status !== 0) throw new Error(`launchctl could not load ${label}`);
  }

  console.log(`\nzumo is configured on 127.0.0.1:${config.port}.`);
  console.log(`Expose it to your tailnet with: tailscale serve --bg ${config.port}`);
  console.log(`Logs: ${logPath}`);
  console.log("For service startup while logged out, keep the Mac signed in (launchd user agents run per-session).");
}

function installSystemdUnits(config) {
  mkdirSync(userUnitDir, { recursive: true });
  const service = [
    "[Unit]",
    "Description=zumo phone mission control",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoRoot}`,
    `Environment=${systemdQuote(`ZUMO_HOME=${zumoHome}`)}`,
    `ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(join(repoRoot, "index.ts"))}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  writeFileSync(join(userUnitDir, "zumo.service"), service);

  const cleanupService = [
    "[Unit]",
    "Description=Prune zumo terminal recordings",
    "",
    "[Service]",
    "Type=oneshot",
    `Environment=${systemdQuote(`ZUMO_HOME=${zumoHome}`)}`,
    `ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(join(repoRoot, "bin", "retention.js"))}`,
    "",
  ].join("\n");
  writeFileSync(join(userUnitDir, "zumo-retention.service"), cleanupService);

  const timer = [
    "[Unit]",
    "Description=Daily zumo recording cleanup",
    "",
    "[Timer]",
    "OnCalendar=daily",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  writeFileSync(join(userUnitDir, "zumo-retention.timer"), timer);

  const systemctl = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  if (systemctl.status === 0) {
    const enable = spawnSync(
      "systemctl",
      ["--user", "enable", "--now", "zumo.service", "zumo-retention.timer"],
      { stdio: "inherit" },
    );
    if (enable.status !== 0) throw new Error("systemd could not enable or start zumo");
  } else {
    throw new Error("could not reload the user systemd instance; unit files were still installed");
  }

  console.log(`\nzumo is configured on 127.0.0.1:${config.port}.`);
  console.log(`Expose it to your tailnet with: tailscale serve --bg ${config.port}`);
  console.log("For service startup while logged out, run once: sudo loginctl enable-linger $USER");
}

assertPrerequisites();
const config = configureZumo();
installHook();
installUnits(config);

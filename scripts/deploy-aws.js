#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const region = process.argv[2] || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const stack = process.env.ZUMO_AWS_STACK || "zumo-relay";
const legacyHome = join(homedir(), ".port23");
const defaultHome = join(homedir(), ".zumo");
const zumoHome = process.env.ZUMO_HOME || process.env.PORT23_HOME
  || (existsSync(defaultHome) ? defaultHome : existsSync(legacyHome) ? legacyHome : defaultHome);
const configPath = join(zumoHome, "config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const relay = config.relay || {};
const deviceId = relay.deviceId || `zumo-${hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${randomBytes(4).toString("hex")}`;
const token = relay.token || randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const temporary = mkdtempSync(join(tmpdir(), "zumo-aws-"));

function aws(args, options = {}) {
  return execFileSync("aws", [...args, "--region", region], {
    cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", ...options,
  });
}

try {
  const identity = JSON.parse(aws(["sts", "get-caller-identity", "--output", "json"], { capture: true }));
  const artifactBucket = `zumo-relay-artifacts-${identity.Account}-${region}`;
  try { aws(["s3api", "head-bucket", "--bucket", artifactBucket], { capture: true }); }
  catch {
    const args = ["s3api", "create-bucket", "--bucket", artifactBucket];
    if (region !== "us-east-1") args.push("--create-bucket-configuration", `LocationConstraint=${region}`);
    aws(args);
  }

  try {
    const status = aws([
      "cloudformation", "describe-stacks", "--stack-name", stack,
      "--query", "Stacks[0].StackStatus", "--output", "text",
    ], { capture: true }).trim();
    if (status === "ROLLBACK_COMPLETE") {
      aws(["cloudformation", "delete-stack", "--stack-name", stack]);
      aws(["cloudformation", "wait", "stack-delete-complete", "--stack-name", stack]);
    }
  } catch { /* stack does not exist yet */ }

  const packaged = join(temporary, "packaged.yaml");
  aws([
    "cloudformation", "package",
    "--template-file", join(root, "infra", "aws", "template.yaml"),
    "--s3-bucket", artifactBucket,
    "--s3-prefix", stack,
    "--output-template-file", packaged,
  ]);
  try {
    aws([
      "cloudformation", "deploy",
      "--template-file", packaged,
      "--stack-name", stack,
      "--capabilities", "CAPABILITY_NAMED_IAM",
      "--parameter-overrides", `DeviceId=${deviceId}`, `DeviceTokenHash=${tokenHash}`,
      "--no-fail-on-empty-changeset",
    ]);
  } catch {
    throw new Error(`CloudFormation deployment failed for ${stack}; inspect its stack events in ${region}`);
  }

  const output = JSON.parse(aws([
    "cloudformation", "describe-stacks", "--stack-name", stack,
    "--query", "Stacks[0].Outputs", "--output", "json",
  ], { capture: true }));
  const outputs = Object.fromEntries(output.map((item) => [item.OutputKey, item.OutputValue]));
  if (!outputs.WebSocketUrl || !outputs.ClientBucketName || !outputs.ClientUrl) throw new Error("stack outputs are incomplete");

  const clientConfig = join(temporary, "config.json");
  writeFileSync(clientConfig, `${JSON.stringify({ webSocketUrl: outputs.WebSocketUrl })}\n`);
  aws([
    "s3", "sync", join(root, "infra", "aws", "client"), `s3://${outputs.ClientBucketName}`,
    "--delete", "--exclude", "config.json", "--exclude", "icon.svg",
  ]);
  aws(["s3", "cp", join(root, "public", "icon.svg"), `s3://${outputs.ClientBucketName}/icon.svg`, "--content-type", "image/svg+xml"]);
  aws(["s3", "cp", clientConfig, `s3://${outputs.ClientBucketName}/config.json`, "--content-type", "application/json", "--cache-control", "no-store"]);
  aws(["cloudfront", "create-invalidation", "--distribution-id", outputs.ClientDistributionId, "--paths", "/*"]);

  config.relay = { url: outputs.WebSocketUrl, clientUrl: outputs.ClientUrl, deviceId, token };
  const configTemporary = `${configPath}.aws-${process.pid}`;
  writeFileSync(configTemporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(configTemporary, configPath);

  console.log(`\nZumo relay deployed: ${outputs.ClientUrl}`);
  console.log(`WebSocket endpoint: ${outputs.WebSocketUrl}`);
  console.log(`Device: ${deviceId}`);
  console.log("Restart Zumo to connect the workstation relay.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

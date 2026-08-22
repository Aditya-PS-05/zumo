import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand,
  QueryCommand, UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const db = new DynamoDBClient({});
const CONNECTIONS = process.env.CONNECTIONS_TABLE;
const PAIRINGS = process.env.PAIRINGS_TABLE;
const DEVICES = process.env.DEVICES_TABLE;
const DEVICE_ID = process.env.DEVICE_ID;
const DEVICE_TOKEN_HASH = process.env.DEVICE_TOKEN_HASH;
const ALLOWED_KINDS = new Set(["snapshot", "action", "command", "ack", "presence"]);

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

function policy(effect, event, principalId, context = {}) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: event.methodArn }],
    },
    context: Object.fromEntries(Object.entries(context).map(([key, value]) => [key, String(value)])),
  };
}

export async function authorize(event) {
  const query = event.queryStringParameters || {};
  const role = String(query.role || "");
  try {
    if (role === "device" && query.device === DEVICE_ID && safeEqual(hash(query.token || ""), DEVICE_TOKEN_HASH)) {
      return policy("Allow", event, `device:${DEVICE_ID}`, { role, deviceId: DEVICE_ID, newPair: false });
    }
    if (role === "client" && query.code) {
      const codeHash = hash(String(query.code).toUpperCase().replace(/[^A-Z2-7]/g, ""));
      const claimed = await db.send(new UpdateItemCommand({
        TableName: PAIRINGS,
        Key: { codeHash: { S: codeHash } },
        ConditionExpression: "expiresAt > :now AND attribute_not_exists(claimedAt)",
        UpdateExpression: "SET claimedAt = :now",
        ExpressionAttributeValues: { ":now": { N: String(now()) } },
        ReturnValues: "ALL_NEW",
      }));
      const deviceId = claimed.Attributes?.deviceId?.S;
      if (deviceId) return policy("Allow", event, `client:${deviceId}`, { role, deviceId, newPair: true, codeHash });
    }
    if (role === "client" && query.device && query.token) {
      const result = await db.send(new GetItemCommand({
        TableName: DEVICES, Key: { deviceId: { S: String(query.device) } }, ConsistentRead: true,
      }));
      if (result.Item?.clientTokenHash?.S && safeEqual(hash(query.token), result.Item.clientTokenHash.S)) {
        return policy("Allow", event, `client:${query.device}`, { role, deviceId: query.device, newPair: false });
      }
    }
  } catch { /* deny without leaking whether a code or token exists */ }
  return policy("Deny", event, "unauthorized");
}

function management(event) {
  return new ApiGatewayManagementApiClient({
    endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
  });
}

async function post(event, connectionId, message) {
  try {
    await management(event).send(new PostToConnectionCommand({
      ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(message)),
    }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 410) {
      await db.send(new DeleteItemCommand({ TableName: CONNECTIONS, Key: { connectionId: { S: connectionId } } }));
      return false;
    }
    throw error;
  }
}

async function connection(connectionId) {
  const result = await db.send(new GetItemCommand({
    TableName: CONNECTIONS, Key: { connectionId: { S: connectionId } }, ConsistentRead: true,
  }));
  return result.Item || null;
}

async function connect(event) {
  const auth = event.requestContext.authorizer || {};
  const connectionId = event.requestContext.connectionId;
  await db.send(new PutItemCommand({
    TableName: CONNECTIONS,
    Item: {
      connectionId: { S: connectionId }, deviceId: { S: auth.deviceId }, role: { S: auth.role },
      newPair: { BOOL: auth.newPair === "true" }, expiresAt: { N: String(now() + 3 * 60 * 60) },
    },
  }));
  if (auth.codeHash) {
    await db.send(new DeleteItemCommand({ TableName: PAIRINGS, Key: { codeHash: { S: auth.codeHash } } }));
  }
  return { statusCode: 200 };
}

async function hello(event, item) {
  const connectionId = event.requestContext.connectionId;
  const role = item.role.S;
  if (role === "client" && item.newPair?.BOOL) {
    const token = randomBytes(32).toString("base64url");
    await Promise.all([
      db.send(new PutItemCommand({
        TableName: DEVICES,
        Item: { deviceId: { S: item.deviceId.S }, clientTokenHash: { S: hash(token) }, updatedAt: { N: String(now()) } },
      })),
      db.send(new UpdateItemCommand({
        TableName: CONNECTIONS, Key: { connectionId: { S: connectionId } },
        UpdateExpression: "SET newPair = :no", ExpressionAttributeValues: { ":no": { BOOL: false } },
      })),
    ]);
    await post(event, connectionId, { type: "paired", deviceId: item.deviceId.S, token });
  } else {
    await post(event, connectionId, { type: "ready", deviceId: item.deviceId.S, role });
  }
}

async function registerPairing(event, item, body) {
  if (item.role.S !== "device") throw new Error("only a device can create a pairing code");
  const code = String(body.code || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (!/^[A-Z2-7]{16}$/.test(code)) throw new Error("pairing code must be 16 base32 characters");
  await db.send(new PutItemCommand({
    TableName: PAIRINGS,
    Item: { codeHash: { S: hash(code) }, deviceId: { S: item.deviceId.S }, expiresAt: { N: String(now() + 300) } },
  }));
  await post(event, event.requestContext.connectionId, { type: "pairingReady", expiresIn: 300 });
}

async function relay(event, item, body) {
  const kind = String(body.kind || "");
  if (!ALLOWED_KINDS.has(kind)) throw new Error("unsupported relay message kind");
  const encoded = JSON.stringify(body.payload ?? null);
  if (Buffer.byteLength(encoded) > 24 * 1024) throw new Error("relay payload is too large");
  const targetRole = item.role.S === "device" ? "client" : "device";
  const result = await db.send(new QueryCommand({
    TableName: CONNECTIONS, IndexName: "DeviceIndex",
    KeyConditionExpression: "deviceId = :device AND #role = :role",
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":device": { S: item.deviceId.S }, ":role": { S: targetRole } },
  }));
  let delivered = 0;
  for (const target of result.Items || []) {
    if (await post(event, target.connectionId.S, { type: "relay", from: item.role.S, kind, payload: body.payload ?? null })) delivered++;
  }
  await post(event, event.requestContext.connectionId, { type: "relayed", kind, delivered });
}

export async function handler(event) {
  const route = event.requestContext.routeKey;
  const connectionId = event.requestContext.connectionId;
  try {
    if (route === "$connect") return await connect(event);
    if (route === "$disconnect") {
      await db.send(new DeleteItemCommand({ TableName: CONNECTIONS, Key: { connectionId: { S: connectionId } } }));
      return { statusCode: 200 };
    }
    const item = await connection(connectionId);
    if (!item) return { statusCode: 401, body: "unknown connection" };
    const body = JSON.parse(event.body || "{}");
    if (route === "hello") await hello(event, item);
    else if (route === "register") await registerPairing(event, item, body);
    else if (route === "relay") await relay(event, item, body);
    else if (route === "heartbeat") {
      await db.send(new UpdateItemCommand({
        TableName: CONNECTIONS, Key: { connectionId: { S: connectionId } },
        UpdateExpression: "SET expiresAt = :ttl", ExpressionAttributeValues: { ":ttl": { N: String(now() + 3 * 60 * 60) } },
      }));
      await post(event, connectionId, { type: "heartbeat", at: Date.now() });
    } else throw new Error("unknown action");
    return { statusCode: 200 };
  } catch (error) {
    try { await post(event, connectionId, { type: "error", message: error.message || "relay error" }); } catch {}
    return { statusCode: 400, body: "request rejected" };
  }
}

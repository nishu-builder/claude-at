import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { REGION, NAMES } from "./config";
import type { JobRecord, ThreadRecord, Identity, ChannelBinding } from "./types";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = process.env.DDB_TABLE ?? NAMES.table;

export const jobPk = (id: string): string => `JOB#${id}`;
export const threadPk = (id: string): string => `THREAD#${id}`;

async function patchItem(pk: string, patch: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = keys.map((k, i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = patch[k];
    return `#k${i} = :v${i}`;
  });
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function putJob(job: JobRecord): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE, Item: job }));
}

export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: jobPk(jobId) } }));
  return r.Item as JobRecord | undefined;
}

export async function updateJob(jobId: string, patch: Partial<JobRecord>): Promise<void> {
  await patchItem(jobPk(jobId), { ...patch, updatedAt: new Date().toISOString() });
}

export async function getThread(threadId: string): Promise<ThreadRecord | undefined> {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: threadPk(threadId) } }));
  return r.Item as ThreadRecord | undefined;
}

export async function putThread(rec: ThreadRecord): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE, Item: rec }));
}

export async function updateThread(threadId: string, patch: Partial<ThreadRecord>): Promise<void> {
  await patchItem(threadPk(threadId), { ...patch, updatedAt: new Date().toISOString() });
}

export const identityPk = (id: string): string => `IDENTITY#${id}`;
export const channelPk = (id: string): string => `CHANNEL#${id}`;

export async function getIdentity(id: string): Promise<Identity | undefined> {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: identityPk(id) } }));
  return r.Item as Identity | undefined;
}

export async function putIdentity(identity: Identity): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE, Item: identity }));
}

export async function listIdentities(): Promise<Identity[]> {
  const r = await doc.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": "IDENTITY#" },
    }),
  );
  return (r.Items ?? []) as Identity[];
}

export async function getIdentityOrDefault(id: string): Promise<Identity> {
  const found = await getIdentity(id);
  if (found) return found;
  return { pk: identityPk(id), id, displayName: "ClaudeTag", persona: "", memoryNs: id, createdAt: "", updatedAt: "" };
}

export async function getChannelBinding(channelId: string): Promise<ChannelBinding | undefined> {
  const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: channelPk(channelId) } }));
  return r.Item as ChannelBinding | undefined;
}

export async function putChannelBinding(channelId: string, identityId: string): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { pk: channelPk(channelId), channelId, identityId, updatedAt: new Date().toISOString() },
    }),
  );
}

export async function listQueuedJobs(): Promise<JobRecord[]> {
  const r = await doc.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: "#s = :q AND begins_with(pk, :j)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":q": "queued", ":j": "JOB#" },
    }),
  );
  return (r.Items ?? []) as JobRecord[];
}

export async function claimJob(jobId: string, taskArn?: string): Promise<boolean> {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: jobPk(jobId) },
        UpdateExpression: taskArn ? "SET #s = :r, taskArn = :t, updatedAt = :u" : "SET #s = :r, updatedAt = :u",
        ConditionExpression: "#s = :q",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: taskArn
          ? { ":r": "running", ":q": "queued", ":t": taskArn, ":u": new Date().toISOString() }
          : { ":r": "running", ":q": "queued", ":u": new Date().toISOString() },
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

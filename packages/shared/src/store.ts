import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { REGION, NAMES } from "./config";
import type { JobRecord, JobStatus, ThreadRecord, Identity, ChannelBinding } from "./types";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = process.env.DDB_TABLE ?? NAMES.table;
// Sparse GSI on `status`; only JOB# items carry that attribute, so a Query here
// touches just the jobs in the requested state instead of Scanning the table.
const STATUS_INDEX = "status-index";

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

async function listJobsByStatus(status: JobStatus): Promise<JobRecord[]> {
  const items: JobRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: "#s = :v",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":v": status },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((r.Items ?? []) as JobRecord[]));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export function listQueuedJobs(): Promise<JobRecord[]> {
  return listJobsByStatus("queued");
}

export function listRunningJobs(): Promise<JobRecord[]> {
  return listJobsByStatus("running");
}

// Atomically move a job out of `running` only if it's still running on the
// same worker we observed as dead. The condition guards against a race where
// the job finished (or was reclaimed) between the reaper's scan and write.
export async function reapJob(
  jobId: string,
  taskArn: string,
  next: { status: "queued" } | { status: "failed"; error: string },
): Promise<boolean> {
  const values: Record<string, unknown> = {
    ":n": next.status,
    ":r": "running",
    ":t": taskArn,
    ":u": new Date().toISOString(),
  };
  let setExpr = "SET #s = :n, updatedAt = :u REMOVE taskArn";
  if (next.status === "failed") {
    values[":e"] = next.error;
    setExpr = "SET #s = :n, error = :e, updatedAt = :u REMOVE taskArn";
  }
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: jobPk(jobId) },
        UpdateExpression: setExpr,
        ConditionExpression: "#s = :r AND taskArn = :t",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

export async function claimJob(jobId: string, taskArn?: string): Promise<boolean> {
  const values: Record<string, unknown> = {
    ":r": "running",
    ":q": "queued",
    ":u": new Date().toISOString(),
    ":one": 1,
    ":zero": 0,
  };
  let setExpr = "SET #s = :r, updatedAt = :u, attempts = if_not_exists(attempts, :zero) + :one";
  if (taskArn) {
    values[":t"] = taskArn;
    setExpr = "SET #s = :r, taskArn = :t, updatedAt = :u, attempts = if_not_exists(attempts, :zero) + :one";
  }
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: jobPk(jobId) },
        UpdateExpression: setExpr,
        ConditionExpression: "#s = :q",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

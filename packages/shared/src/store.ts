import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { REGION, NAMES } from "./config";
import type { JobRecord, ThreadRecord } from "./types";

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

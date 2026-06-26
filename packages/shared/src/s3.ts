import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { REGION } from "./config";

const s3 = new S3Client({ region: REGION });

export async function getObjectText(bucket: string, key: string): Promise<string | undefined> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await res.Body?.transformToString();
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return undefined;
    throw err;
  }
}

export async function putObjectText(
  bucket: string,
  key: string,
  body: string,
  contentType = "text/plain",
): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

// Mirror every object under `prefix` into `destDir`, preserving the key suffix
// as the relative path. An object is fetched only when the local file is absent
// or its size differs — so a warm pool worker that already synced a large
// dataset on an earlier job skips the download. Returns the number of objects
// downloaded (vs. served from the on-disk cache). Requires `s3:ListBucket`.
export async function syncPrefix(
  bucket: string,
  prefix: string,
  destDir: string,
): Promise<{ downloaded: number; total: number }> {
  const norm = prefix.replace(/^\/+/, "").replace(/\/?$/, prefix ? "/" : "");
  let downloaded = 0;
  let total = 0;
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: norm, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      const key = obj.Key;
      if (!key || key.endsWith("/")) continue;
      total++;
      const rel = key.slice(norm.length);
      if (!rel) continue;
      const dest = join(destDir, rel);
      const cached = await stat(dest).catch(() => undefined);
      if (cached && cached.size === obj.Size) continue;
      await mkdir(dirname(dest), { recursive: true });
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (got.Body) {
        await pipeline(got.Body as Readable, createWriteStream(dest));
        downloaded++;
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return { downloaded, total };
}

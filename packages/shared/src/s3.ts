import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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

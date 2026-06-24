import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { REGION } from "./config";

const client = new SecretsManagerClient({ region: REGION });
const cache = new Map<string, string>();

export async function getSecret(secretId: string): Promise<string> {
  const hit = cache.get(secretId);
  if (hit !== undefined) return hit;
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) throw new Error(`secret ${secretId} has no string value`);
  cache.set(secretId, res.SecretString);
  return res.SecretString;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  pk: string;
  jobId: string;
  status: JobStatus;
  prompt: string;
  guildId: string;
  channelId: string;
  parentChannelId?: string;
  threadId: string;
  userId: string;
  identityId?: string;
  repo?: string;
  resumeSessionId?: string;
  progressMessageId?: string;
  taskArn?: string;
  attempts?: number;
  resultSessionId?: string;
  costUsd?: number;
  prUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadRecord {
  pk: string;
  threadId: string;
  identityId?: string;
  repo?: string;
  claudeSessionId?: string;
  lastJobId?: string;
  updatedAt: string;
}

// A dataset provisioned into a job's workdir. `source` is an `s3://bucket/prefix`
// URI or a bare prefix within DATA_BUCKET; its objects are synced to a dir named
// `name` under the data mount and exposed via `CLAUDE_AT_DATA_<NAME>`.
export interface DatasetMount {
  name: string;
  source: string;
}

// A named secret injected into the job's environment (the hook + the agent) as
// `env`. `secretId` must live under the data secret scope (`claude-at/data/*`).
export interface SecretMount {
  env: string;
  secretId: string;
}

export interface Identity {
  pk: string;
  id: string;
  displayName: string;
  persona: string;
  avatarUrl?: string;
  defaultRepo?: string;
  allowedRepos?: string[];
  allowedTools?: string[];
  datasets?: DatasetMount[];
  secrets?: SecretMount[];
  memoryNs: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelBinding {
  pk: string;
  channelId: string;
  identityId: string;
  updatedAt: string;
}

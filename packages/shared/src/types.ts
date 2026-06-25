export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  pk: string;
  jobId: string;
  status: JobStatus;
  prompt: string;
  guildId: string;
  channelId: string;
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

export interface Identity {
  pk: string;
  id: string;
  displayName: string;
  persona: string;
  defaultRepo?: string;
  allowedRepos?: string[];
  allowedTools?: string[];
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

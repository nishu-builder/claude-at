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
  repo?: string;
  resumeSessionId?: string;
  progressMessageId?: string;
  taskArn?: string;
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
  repo?: string;
  claudeSessionId?: string;
  lastJobId?: string;
  updatedAt: string;
}

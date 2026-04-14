import type { BackgroundJobRecord } from "./backgroundJobs";

export const GROUP_ITERATION_JOB_TYPE = "group_iteration";
export const GROUP_ITERATION_JOB_ID_PREFIX = `${GROUP_ITERATION_JOB_TYPE}:`;
export const GROUP_ITERATION_INTERVAL_MS = 4200;
export const GROUP_ITERATION_MIN_TRIGGER_GAP_MS = 3200;
export const GROUP_ITERATION_LEASE_MS = 15000;
export const GROUP_ITERATION_RETRY_DELAY_MS = 6500;

export const TOPIC_GENERATION_JOB_TYPE = "topic_generation";
export const TOPIC_GENERATION_JOB_ID_PREFIX = `${TOPIC_GENERATION_JOB_TYPE}:`;
export const TOPIC_GENERATION_LEASE_MS = 45000;
export const TOPIC_GENERATION_MIN_TRIGGER_GAP_MS = 1200;
export const TOPIC_GENERATION_RETRY_DELAY_MS = 6500;

function readPayloadStringField(payload: unknown, field: string) {
  if (typeof payload !== "object" || payload === null) return "";
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value.trim() : "";
}

export function buildGroupIterationJobId(roomId: string) {
  return `${GROUP_ITERATION_JOB_ID_PREFIX}${roomId.trim()}`;
}

export function readGroupIterationRoomId(
  job: Pick<BackgroundJobRecord, "id" | "payload">,
) {
  const roomIdFromPayload = readPayloadStringField(job.payload, "roomId");
  if (roomIdFromPayload) return roomIdFromPayload;
  if (job.id.startsWith(GROUP_ITERATION_JOB_ID_PREFIX)) {
    return job.id.slice(GROUP_ITERATION_JOB_ID_PREFIX.length).trim();
  }
  return "";
}

export function buildTopicGenerationJobId(sessionId: string) {
  return `${TOPIC_GENERATION_JOB_ID_PREFIX}${sessionId.trim()}`;
}

export function readTopicGenerationSessionId(
  job: Pick<BackgroundJobRecord, "id" | "payload">,
) {
  const sessionIdFromPayload = readPayloadStringField(job.payload, "sessionId");
  if (sessionIdFromPayload) return sessionIdFromPayload;
  if (job.id.startsWith(TOPIC_GENERATION_JOB_ID_PREFIX)) {
    return job.id.slice(TOPIC_GENERATION_JOB_ID_PREFIX.length).trim();
  }
  return "";
}

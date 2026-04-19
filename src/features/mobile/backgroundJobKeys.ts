import type { BackgroundJobRecord } from "./backgroundJobs";

export const GROUP_ITERATION_JOB_TYPE = "group_iteration";
export const GROUP_ITERATION_JOB_ID_PREFIX = `${GROUP_ITERATION_JOB_TYPE}:`;
export const GROUP_ITERATION_INTERVAL_MS = 4200;
export const GROUP_ITERATION_MIN_TRIGGER_GAP_MS = 3200;
export const GROUP_ITERATION_LEASE_MS = 15000;
export const GROUP_ITERATION_RETRY_DELAY_MS = 6500;

export const ONE_TO_ONE_CHAT_JOB_TYPE = "one_to_one_chat";
export const ONE_TO_ONE_CHAT_JOB_ID_PREFIX = `${ONE_TO_ONE_CHAT_JOB_TYPE}:`;
export const ONE_TO_ONE_CHAT_RETRY_DELAY_MS = 6500;
export const ONE_TO_ONE_CHAT_MAX_ATTEMPTS = 3;

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

export function buildOneToOneChatJobId(chatId: string, userMessageId: string) {
  return `${ONE_TO_ONE_CHAT_JOB_ID_PREFIX}${chatId.trim()}:${userMessageId.trim()}`;
}

export function readOneToOneChatScope(
  job: Pick<BackgroundJobRecord, "id" | "payload">,
) {
  const chatId = readPayloadStringField(job.payload, "chatId");
  const userMessageId = readPayloadStringField(job.payload, "userMessageId");
  if (chatId && userMessageId) {
    return { chatId, userMessageId };
  }
  if (job.id.startsWith(ONE_TO_ONE_CHAT_JOB_ID_PREFIX)) {
    const raw = job.id.slice(ONE_TO_ONE_CHAT_JOB_ID_PREFIX.length).trim();
    const separatorIndex = raw.indexOf(":");
    if (separatorIndex > 0 && separatorIndex < raw.length - 1) {
      return {
        chatId: raw.slice(0, separatorIndex).trim(),
        userMessageId: raw.slice(separatorIndex + 1).trim(),
      };
    }
  }
  return { chatId: "", userMessageId: "" };
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

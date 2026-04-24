import { describe, expect, it } from "vitest";
import {
  ONE_TO_ONE_CHAT_JOB_TYPE,
  ONE_TO_ONE_PROACTIVE_JOB_TYPE,
} from "./backgroundJobKeys";
import { ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS } from "./useOneToOneBackgroundWorker";

describe("useOneToOneBackgroundWorker delta task config", () => {
  it("includes chat and proactive task types for polling", () => {
    const taskTypes = ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS.map(
      (item) => item.taskType,
    );
    expect(taskTypes).toEqual([
      ONE_TO_ONE_CHAT_JOB_TYPE,
      ONE_TO_ONE_PROACTIVE_JOB_TYPE,
    ]);
  });

  it("uses unique since-id storage keys per task type", () => {
    const keys = ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS.map(
      (item) => item.sinceIdStorageKey,
    );
    expect(new Set(keys).size).toBe(ONE_TO_ONE_DELTA_TASK_POLL_CONFIGS.length);
  });
});


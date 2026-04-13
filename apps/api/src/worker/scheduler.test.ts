import { describe, expect, it, vi } from "vitest";
import { createScheduler } from "./scheduler.js";

describe("scheduler", () => {
  it("ticks on interval", async () => {
    const run = vi.fn();
    const scheduler = createScheduler({ intervalMs: 10, run });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 35));
    scheduler.stop();
    expect(run).toHaveBeenCalled();
  });
});


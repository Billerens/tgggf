import { describe, expect, it } from "vitest";
import {
  getNewMessageIds,
  getStoredMessageScrollTop,
  isNearBottom,
  parseMessageScrollState,
  setStoredMessageScrollTop,
  MESSAGE_SCROLL_STORAGE_KEY,
} from "./messageScrollState";

function createMemoryStorage(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } as Storage;
}

describe("messageScrollState", () => {
  it("falls back to empty state for invalid payload", () => {
    const parsed = parseMessageScrollState("{broken json");
    expect(parsed.group).toEqual({});
    expect(parsed.chat).toEqual({});
  });

  it("ignores malformed entries but keeps valid ones", () => {
    const parsed = parseMessageScrollState(
      JSON.stringify({
        version: 1,
        group: {
          room_ok: { scrollTop: 128, updatedAt: 1700 },
          room_bad_top: { scrollTop: "bad", updatedAt: 1800 },
          room_bad_time: { scrollTop: 64, updatedAt: "bad" },
        },
        chat: {
          chat_ok: { scrollTop: 9, updatedAt: 2200 },
        },
      }),
    );
    expect(parsed.group).toEqual({
      room_ok: { scrollTop: 128, updatedAt: 1700 },
    });
    expect(parsed.chat).toEqual({
      chat_ok: { scrollTop: 9, updatedAt: 2200 },
    });
  });

  it("returns only truly new message ids", () => {
    expect(getNewMessageIds([], ["m1", "m2"])).toEqual([]);
    expect(getNewMessageIds(["m1", "m2"], ["m1", "m2"])).toEqual([]);
    expect(getNewMessageIds(["m1", "m2"], ["m1", "m2", "m3", "m4"])).toEqual([
      "m3",
      "m4",
    ]);
    expect(getNewMessageIds(["m1", "m2"], ["m2", "m3"])).toEqual(["m3"]);
  });

  it("stores and reads per-stream scrollTop values", () => {
    const storage = createMemoryStorage();
    setStoredMessageScrollTop({
      streamType: "group",
      streamId: "room_1",
      scrollTop: 420,
      updatedAt: 1000,
      storage,
    });
    setStoredMessageScrollTop({
      streamType: "chat",
      streamId: "chat_1",
      scrollTop: 120,
      updatedAt: 1200,
      storage,
    });

    expect(getStoredMessageScrollTop("group", "room_1", storage)).toBe(420);
    expect(getStoredMessageScrollTop("chat", "chat_1", storage)).toBe(120);
    expect(getStoredMessageScrollTop("group", "missing", storage)).toBeNull();

    const raw = storage.getItem(MESSAGE_SCROLL_STORAGE_KEY);
    expect(raw).toBeTypeOf("string");
  });

  it("detects near-bottom with configured threshold", () => {
    expect(
      isNearBottom({
        scrollTop: 920,
        scrollHeight: 1000,
        clientHeight: 40,
        thresholdPx: 80,
      }),
    ).toBe(true);
    expect(
      isNearBottom({
        scrollTop: 850,
        scrollHeight: 1000,
        clientHeight: 40,
        thresholdPx: 80,
      }),
    ).toBe(false);
  });
});


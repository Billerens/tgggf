import { describe, expect, it, vi } from "vitest";
import {
  isSpeechInputSupported,
  transcribeSpeechInput,
} from "./speechInput";

describe("speechInput", () => {
  it("reports unsupported when LocalApi speech plugin is absent", () => {
    expect(isSpeechInputSupported({})).toBe(false);
  });

  it("detects support when transcribeSpeech exists", () => {
    const scope = {
      Capacitor: {
        Plugins: {
          LocalApi: {
            transcribeSpeech: vi.fn(),
          },
        },
      },
    };
    expect(isSpeechInputSupported(scope)).toBe(true);
  });

  it("returns normalized transcript text from plugin", async () => {
    const transcribeSpeech = vi.fn().mockResolvedValue({
      ok: true,
      text: "  Привет мир  ",
      alternatives: ["Привет мир"],
    });
    const scope = {
      Capacitor: {
        Plugins: {
          LocalApi: {
            transcribeSpeech,
          },
        },
      },
    };

    const text = await transcribeSpeechInput(
      { prompt: "Говорите", maxResults: 10 },
      { scope },
    );
    expect(text).toBe("Привет мир");
    expect(transcribeSpeech).toHaveBeenCalledWith({
      locale: undefined,
      prompt: "Говорите",
      maxResults: 5,
    });
  });

  it("throws speech_not_supported when plugin is missing", async () => {
    await expect(transcribeSpeechInput({}, { scope: {} })).rejects.toThrow(
      "speech_not_supported",
    );
  });

  it("passes plugin error code through", async () => {
    const scope = {
      Capacitor: {
        Plugins: {
          LocalApi: {
            transcribeSpeech: vi
              .fn()
              .mockRejectedValue(new Error("microphone_permission_denied")),
          },
        },
      },
    };

    await expect(transcribeSpeechInput({}, { scope })).rejects.toThrow(
      "microphone_permission_denied",
    );
  });
});


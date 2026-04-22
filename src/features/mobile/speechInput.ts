interface LocalApiTranscribeSpeechInput {
  locale?: string;
  prompt?: string;
  maxResults?: number;
}

interface LocalApiTranscribeSpeechOutput {
  ok?: boolean;
  text?: unknown;
  error?: unknown;
}

interface LocalApiPlugin {
  transcribeSpeech?: (
    input?: LocalApiTranscribeSpeechInput,
  ) => Promise<LocalApiTranscribeSpeechOutput>;
}

interface LocalApiSpeechPlugin {
  transcribeSpeech: (
    input?: LocalApiTranscribeSpeechInput,
  ) => Promise<LocalApiTranscribeSpeechOutput>;
}

interface CapacitorLikeScope {
  Capacitor?: {
    Plugins?: {
      LocalApi?: LocalApiPlugin;
    };
  };
}

export interface TranscribeSpeechOptions {
  locale?: string;
  prompt?: string;
  maxResults?: number;
}

export interface SpeechInputRequestOptions {
  scope?: CapacitorLikeScope;
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiSpeechPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.transcribeSpeech !== "function") {
    return null;
  }
  return plugin as LocalApiSpeechPlugin;
}

function extractErrorCode(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const message = (error as { message: string }).message.trim();
    if (message) return message;
  }
  return "speech_request_failed";
}

export function isSpeechInputSupported(scope?: CapacitorLikeScope) {
  const resolvedScope = scope ?? (globalThis as unknown as CapacitorLikeScope);
  return Boolean(resolveLocalApiPlugin(resolvedScope));
}

export async function transcribeSpeechInput(
  input: TranscribeSpeechOptions = {},
  options: SpeechInputRequestOptions = {},
) {
  const scope = options.scope ?? (globalThis as unknown as CapacitorLikeScope);
  const plugin = resolveLocalApiPlugin(scope);
  if (!plugin) {
    throw new Error("speech_not_supported");
  }

  const maxResults =
    typeof input.maxResults === "number" && Number.isFinite(input.maxResults)
      ? Math.max(1, Math.min(5, Math.floor(input.maxResults)))
      : 1;

  let response: LocalApiTranscribeSpeechOutput;
  try {
    response = await plugin.transcribeSpeech({
      locale: input.locale,
      prompt: input.prompt,
      maxResults,
    });
  } catch (error) {
    throw new Error(extractErrorCode(error));
  }

  const text = typeof response?.text === "string" ? response.text.trim() : "";
  if (!text) {
    const errorCode = typeof response?.error === "string" ? response.error.trim() : "";
    throw new Error(errorCode || "speech_empty_result");
  }
  return text;
}

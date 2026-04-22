import { registerPlugin } from "@capacitor/core";

export interface LocalApiHealthPayload {
  ok: boolean;
  service: string;
}

export interface LocalApiRequestInput {
  method: string;
  path: string;
  body?: unknown;
}

export interface LocalApiRequestOutput {
  status: number;
  body: unknown;
}

export interface LocalApiTranscribeSpeechInput {
  locale?: string;
  prompt?: string;
  maxResults?: number;
}

export interface LocalApiTranscribeSpeechOutput {
  ok: boolean;
  text: string;
  alternatives?: string[];
}

export interface LocalApiPlugin {
  health(): Promise<LocalApiHealthPayload>;
  request(input: LocalApiRequestInput): Promise<LocalApiRequestOutput>;
  transcribeSpeech(
    input?: LocalApiTranscribeSpeechInput,
  ): Promise<LocalApiTranscribeSpeechOutput>;
}

export const LocalApi = registerPlugin<LocalApiPlugin>("LocalApi");


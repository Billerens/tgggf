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

export interface LocalApiPlugin {
  health(): Promise<LocalApiHealthPayload>;
  request(input: LocalApiRequestInput): Promise<LocalApiRequestOutput>;
}

export const LocalApi = registerPlugin<LocalApiPlugin>("LocalApi");


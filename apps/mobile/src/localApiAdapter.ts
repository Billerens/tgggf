export interface NativeHealthPayload {
  ok: boolean;
  service: string;
}

export interface SharedHealthPayload {
  ok: boolean;
  service: string;
}

export function mapBridgeHealthPayload(payload: NativeHealthPayload): SharedHealthPayload {
  return {
    ok: payload.ok,
    service: payload.service,
  };
}


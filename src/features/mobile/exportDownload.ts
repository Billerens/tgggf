interface LocalApiPluginRequestInput {
  method: "PUT";
  path: string;
  body?: unknown;
}

interface LocalApiPluginRequestOutput {
  status: number;
  body: unknown;
}

interface LocalApiPlugin {
  request(input: LocalApiPluginRequestInput): Promise<LocalApiPluginRequestOutput>;
}

interface CapacitorLikeScope {
  Capacitor?: {
    Plugins?: {
      LocalApi?: LocalApiPlugin;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveLocalApiPlugin(scope: CapacitorLikeScope): LocalApiPlugin | null {
  const plugin = scope.Capacitor?.Plugins?.LocalApi;
  if (!plugin || typeof plugin.request !== "function") return null;
  return plugin;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === "undefined") {
    return Promise.reject(new Error("file_reader_unavailable"));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("blob_to_data_url_failed"));
    reader.readAsDataURL(blob);
  });
}

function parseDataUrlPayload(dataUrl: string) {
  const normalized = dataUrl.trim();
  if (!normalized.startsWith("data:")) {
    return {
      mimeType: "application/octet-stream",
      dataBase64: normalized,
    };
  }
  const commaIndex = normalized.indexOf(",");
  const meta = commaIndex >= 0 ? normalized.slice(5, commaIndex) : normalized.slice(5);
  const dataBase64 =
    commaIndex >= 0 && commaIndex + 1 < normalized.length
      ? normalized.slice(commaIndex + 1)
      : "";
  const mimeToken = meta.split(";")[0]?.trim();
  return {
    mimeType: mimeToken || "application/octet-stream",
    dataBase64,
  };
}

export async function downloadExportFileOnAndroid(params: {
  fileName: string;
  blob: Blob;
}) {
  const scope = globalThis as unknown as CapacitorLikeScope;
  const plugin = resolveLocalApiPlugin(scope);
  if (!plugin) {
    throw new Error("native_export_bridge_unavailable");
  }

  const dataUrl = await blobToDataUrl(params.blob);
  const payload = parseDataUrlPayload(dataUrl);
  if (!payload.dataBase64) {
    throw new Error("native_export_payload_empty");
  }

  const response = await plugin.request({
    method: "PUT",
    path: "/api/export-file",
    body: {
      fileName: params.fileName,
      mimeType: payload.mimeType,
      dataBase64: payload.dataBase64,
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`native_export_http_${response.status}`);
  }

  if (isRecord(response.body) && response.body.ok === false) {
    const error = typeof response.body.error === "string" ? response.body.error : "";
    throw new Error(error || "native_export_failed");
  }

  const savedAs =
    isRecord(response.body) && typeof response.body.savedAs === "string"
      ? response.body.savedAs
      : "";

  return {
    savedAs: savedAs.trim(),
  };
}


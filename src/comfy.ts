import type { EndpointAuthConfig } from "./types";

interface ComfyNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
  _meta?: { title?: string };
}

type ComfyWorkflow = Record<string, ComfyNode>;

interface ComfyUiWorkflowNode {
  id: string;
  type?: string;
  title?: string;
  widgets_values?: unknown[];
}

interface ComfyUiWorkflow {
  nodes: ComfyUiWorkflowNode[];
}

interface ComfyPromptResponse {
  prompt_id?: string;
}

interface ComfyHistoryImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryNodeOutput {
  images?: ComfyHistoryImage[];
}

interface ComfyHistoryEntry {
  outputs?: Record<string, ComfyHistoryNodeOutput>;
}

const DEFAULT_COMFY_BASE_URL = "http://127.0.0.1:8188";
const POSITIVE_PROMPT_NODE_ID = "1050";
const OUTPUT_TITLE_PREFERENCES = [
  "Preview after Detailing",
  "Preview after Inpaint",
];
const HISTORY_TIMEOUT_MS = 180000;
const HISTORY_POLL_INTERVAL_MS = 1200;

let workflowTemplateCache: ComfyWorkflow | null = null;

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function getComfyBaseUrl(overrideBaseUrl?: string) {
  const fromEnv = import.meta.env.VITE_COMFY_BASE_URL?.trim();
  const source = overrideBaseUrl?.trim() || fromEnv || DEFAULT_COMFY_BASE_URL;
  return normalizeBaseUrl(source);
}

function encodeBase64(value: string) {
  try {
    return btoa(value);
  } catch {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
}

function buildAuthHeaders(auth?: EndpointAuthConfig) {
  if (!auth) return {};
  const headers: Record<string, string> = {};
  const token = auth.token.trim();

  if (auth.mode === "none") return headers;
  if (auth.mode === "basic") {
    if (auth.username || auth.password) {
      headers.Authorization = `Basic ${encodeBase64(`${auth.username}:${auth.password}`)}`;
    }
    return headers;
  }
  if (auth.mode === "custom") {
    if (!token) return headers;
    const name = auth.headerName.trim() || "Authorization";
    const prefix = auth.headerPrefix.trim();
    headers[name] = prefix ? `${prefix} ${token}` : token;
    return headers;
  }
  if (!token) return headers;
  headers.Authorization =
    auth.mode === "token" ? `Token ${token}` : `Bearer ${token}`;
  return headers;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function loadWorkflowTemplate() {
  if (workflowTemplateCache) {
    return workflowTemplateCache;
  }

  const response = await fetch("comfy_api.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Не удалось загрузить comfy_api.json (${response.status})`);
  }

  const payload = (await response.json()) as ComfyWorkflow;
  workflowTemplateCache = payload;
  return payload;
}

function createWorkflowInstance(template: ComfyWorkflow) {
  return structuredClone(template) as ComfyWorkflow;
}

function setPositivePrompt(workflow: ComfyWorkflow, prompt: string) {
  const node = workflow[POSITIVE_PROMPT_NODE_ID];
  if (!node || !node.inputs) {
    throw new Error(`Нода ${POSITIVE_PROMPT_NODE_ID} не найдена в workflow.`);
  }
  node.inputs.text = prompt;
}

function resolveCheckpointName(workflow: ComfyWorkflow) {
  for (const node of Object.values(workflow)) {
    const ckptName = node.inputs?.ckpt_name;
    if (typeof ckptName === "string" && ckptName.trim()) {
      return ckptName;
    }
  }
  return "api-model";
}

function sanitizeWorkflowForApi(workflow: ComfyWorkflow) {
  const checkpointName = resolveCheckpointName(workflow);

  for (const node of Object.values(workflow)) {
    if (node.class_type !== "Image Saver" || !node.inputs) continue;

    const modelname = node.inputs.modelname;
    const dependsOnWidgetToString =
      Array.isArray(modelname) &&
      modelname.length >= 1 &&
      String(modelname[0]) === "282";

    if (dependsOnWidgetToString) {
      node.inputs.modelname = checkpointName;
    }
  }
}

function resolvePreferredOutputNodeIds(workflow: ComfyWorkflow) {
  const preferred: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const title = node._meta?.title ?? "";
    if (!title) continue;
    if (OUTPUT_TITLE_PREFERENCES.some((token) => title.includes(token))) {
      preferred.push(nodeId);
    }
  }
  return preferred;
}

function buildUiWorkflowForExtraPngInfo(workflow: ComfyWorkflow): ComfyUiWorkflow {
  const nodes: ComfyUiWorkflowNode[] = Object.entries(workflow).map(
    ([nodeId, node]) => ({
      id: nodeId,
      type: node.class_type,
      title: node._meta?.title,
      widgets_values: [],
    }),
  );

  return { nodes };
}

async function queuePrompt(
  baseUrl: string,
  workflow: ComfyWorkflow,
  auth?: EndpointAuthConfig,
) {
  const uiWorkflow = buildUiWorkflowForExtraPngInfo(workflow);

  const response = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(auth) },
    body: JSON.stringify({
      client_id: crypto.randomUUID(),
      prompt: workflow,
      // Some custom nodes expect UI-like workflow metadata here
      // (for example ShowText|pysssss reads workflow.nodes).
      extra_data: {
        extra_pnginfo: {
          workflow: uiWorkflow,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ComfyUI /prompt error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as ComfyPromptResponse;
  if (!data.prompt_id) {
    throw new Error("ComfyUI не вернул prompt_id.");
  }

  return data.prompt_id;
}

async function waitForHistory(
  baseUrl: string,
  promptId: string,
  auth?: EndpointAuthConfig,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= HISTORY_TIMEOUT_MS) {
    const response = await fetch(
      `${baseUrl}/history/${encodeURIComponent(promptId)}`,
      {
        cache: "no-store",
        headers: buildAuthHeaders(auth),
      },
    );

    if (response.ok) {
      const payload = (await response.json()) as Record<
        string,
        ComfyHistoryEntry
      >;
      const historyEntry = payload[promptId];
      if (
        historyEntry?.outputs &&
        Object.keys(historyEntry.outputs).length > 0
      ) {
        return historyEntry;
      }
    }

    await sleep(HISTORY_POLL_INTERVAL_MS);
  }

  throw new Error("ComfyUI: таймаут ожидания результата генерации.");
}

function buildViewUrl(baseUrl: string, image: ComfyHistoryImage) {
  const filename = encodeURIComponent(image.filename);
  const subfolder = encodeURIComponent(image.subfolder ?? "");
  const type = encodeURIComponent(image.type ?? "output");
  return `${baseUrl}/view?filename=${filename}&subfolder=${subfolder}&type=${type}`;
}

function collectImageUrls(
  baseUrl: string,
  workflow: ComfyWorkflow,
  historyEntry: ComfyHistoryEntry,
) {
  const outputs = historyEntry.outputs ?? {};
  const preferredNodeIds = resolvePreferredOutputNodeIds(workflow);

  const preferredImages = preferredNodeIds.flatMap(
    (nodeId) => outputs[nodeId]?.images ?? [],
  );
  const fallbackImages =
    preferredImages.length > 0
      ? []
      : Object.values(outputs).flatMap((nodeOutput) => nodeOutput.images ?? []);

  const images = preferredImages.length > 0 ? preferredImages : fallbackImages;
  const urls = images
    .filter((image) => Boolean(image?.filename))
    .map((image) => buildViewUrl(baseUrl, image));

  return Array.from(new Set(urls));
}

export async function generateComfyImages(
  prompts: string[],
  baseUrlOverride?: string,
  auth?: EndpointAuthConfig,
) {
  const cleanedPrompts = prompts.map((prompt) => prompt.trim()).filter(Boolean);
  if (cleanedPrompts.length === 0) return [];

  const baseUrl = getComfyBaseUrl(baseUrlOverride);
  const template = await loadWorkflowTemplate();
  const resultUrls: string[] = [];

  for (const prompt of cleanedPrompts) {
    const workflow = createWorkflowInstance(template);
    setPositivePrompt(workflow, prompt);
    sanitizeWorkflowForApi(workflow);
    const promptId = await queuePrompt(baseUrl, workflow, auth);
    const historyEntry = await waitForHistory(baseUrl, promptId, auth);
    const imageUrls = collectImageUrls(baseUrl, workflow, historyEntry);
    resultUrls.push(...imageUrls);
  }

  return Array.from(new Set(resultUrls));
}

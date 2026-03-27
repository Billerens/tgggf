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

declare global {
  interface Window {
    __TG_GF_LAST_COMFY_DEBUG__?: unknown;
  }
}

export interface ComfyImageGenerationMeta {
  seed?: number;
  prompt?: string;
}

export interface ComfyGenerationItem {
  prompt: string;
  flow?: "base" | "i2i";
  width?: number;
  height?: number;
  seed?: number;
  checkpointName?: string;
  styleReferenceImage?: string;
  styleStrength?: number;
  compositionStrength?: number;
  forceHiResFix?: boolean;
  enableUpscaler?: boolean;
  upscaleFactor?: number;
  hiresFixDenoise?: number;
  colorFixStrength?: number;
  outputNodeTitleIncludes?: string[];
  strictOutputNodeMatch?: boolean;
  pickLatestImageOnly?: boolean;
  detailing?: {
    enabled?: boolean;
    level?: "soft" | "medium" | "strong";
    targets?: Array<"face" | "eyes" | "nose" | "lips" | "hands">;
    prompts?: Partial<Record<"face" | "eyes" | "nose" | "lips" | "hands", string>>;
  };
}

type DetailLevel = "soft" | "medium" | "strong";
type DetailTarget = "face" | "eyes" | "nose" | "lips" | "hands";
export type ComfyFlow = "base" | "i2i";

const DEFAULT_COMFY_BASE_URL = "http://127.0.0.1:8188";
const BASE_WORKFLOW_TEMPLATE_PATH = "comfy_api.json";
const I2I_WORKFLOW_TEMPLATE_PATH = "comfy_api_i2i_2.json";
const POSITIVE_PROMPT_NODE_ID = "1050";
const SIZE_NODE_ID = "141";
const SEED_NODE_ID = "137";
const STYLE_IMAGE_NODE_ID = "420";
const COMPOSITION_IMAGE_NODE_ID = "455";
const STYLE_STRENGTH_NODE_ID = "430";
const COMPOSITION_STRENGTH_NODE_ID = "431";
const HIRES_FIX_NODE_ID = "849";
const I2I_POSITIVE_PROMPT_NODE_ID = "984";
const I2I_IMG2IMG_PROMPT_NODE_ID = "991";
const I2I_INPAINT_POSITIVE_NODE_ID = "984";
const I2I_SEED_NODE_ID = "522";
const I2I_LAST_IMAGE_NODE_ID = "1050";
const I2I_STYLE_STRENGTH_NODE_ID = "430";
const I2I_MULTI_IMAGE_LIST_NODE_ID = "745";
const BASE_OUTPUT_TITLE_PREFERENCES = [
  "Preview after Detailing",
  "Preview after Inpaint",
];
const I2I_OUTPUT_TITLE_PREFERENCES = [
  "Preview after Upscale/HiRes Fix",
  "Preview after Detailing",
];
const WEBP_QUALITY = 82;
const HISTORY_TIMEOUT_MS = 600000;
const HISTORY_POLL_INTERVAL_MS = 1200;

interface ComfyFlowConfig {
  templatePath: string;
  positivePromptNodeId: string;
  positivePromptNodeIds?: string[];
  promptFallbackNodeId?: string;
  promptSwitchTitle?: string;
  promptSwitchInputName?: string;
  promptSwitchFallbackValue?: number | string | boolean;
  sizeNodeId?: string;
  seedNodeId?: string;
  styleImageNodeId?: string;
  styleImageNodeIds?: string[];
  imageListNodeId?: string;
  sourceImageSwitchTitle?: string;
  sourceImageSwitchInputName?: string;
  sourceImageSwitchValue?: number | string | boolean;
  compositionImageNodeId?: string;
  styleStrengthNodeId?: string;
  compositionStrengthNodeId?: string;
  hiresFixNodeId?: string;
  outputTitlePreferences: string[];
  detailPromptTitles: Record<DetailTarget, string>;
  requiresReferenceImage?: boolean;
}

const FLOW_CONFIGS: Record<ComfyFlow, ComfyFlowConfig> = {
  base: {
    templatePath: BASE_WORKFLOW_TEMPLATE_PATH,
    positivePromptNodeId: POSITIVE_PROMPT_NODE_ID,
    sizeNodeId: SIZE_NODE_ID,
    seedNodeId: SEED_NODE_ID,
    styleImageNodeId: STYLE_IMAGE_NODE_ID,
    compositionImageNodeId: COMPOSITION_IMAGE_NODE_ID,
    styleStrengthNodeId: STYLE_STRENGTH_NODE_ID,
    compositionStrengthNodeId: COMPOSITION_STRENGTH_NODE_ID,
    hiresFixNodeId: HIRES_FIX_NODE_ID,
    outputTitlePreferences: BASE_OUTPUT_TITLE_PREFERENCES,
    detailPromptTitles: {
      face: "Face",
      eyes: "Eyes",
      nose: "Nose",
      lips: "Lips",
      hands: "Hands",
    },
  },
  i2i: {
    templatePath: I2I_WORKFLOW_TEMPLATE_PATH,
    positivePromptNodeId: I2I_POSITIVE_PROMPT_NODE_ID,
    positivePromptNodeIds: [
      I2I_IMG2IMG_PROMPT_NODE_ID,
      I2I_INPAINT_POSITIVE_NODE_ID,
    ],
    promptFallbackNodeId: "1051",
    promptSwitchTitle: "prompt switch",
    promptSwitchInputName: "Input",
    promptSwitchFallbackValue: 2,
    seedNodeId: I2I_SEED_NODE_ID,
    styleImageNodeIds: [],
    imageListNodeId: I2I_MULTI_IMAGE_LIST_NODE_ID,
    sourceImageSwitchTitle: "Input Image Switch",
    sourceImageSwitchInputName: "Input",
    sourceImageSwitchValue: 1,
    styleStrengthNodeId: I2I_STYLE_STRENGTH_NODE_ID,
    outputTitlePreferences: I2I_OUTPUT_TITLE_PREFERENCES,
    detailPromptTitles: {
      face: "Face Clip transform",
      eyes: "Eyes Clip transform",
      nose: "Nose Clip transform",
      lips: "Lips Clip transform",
      hands: "Hands Clip transform",
    },
    requiresReferenceImage: true,
  },
};

let workflowTemplateCache: Partial<Record<ComfyFlow, ComfyWorkflow>> = {};

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

function getComfyBaseUrl(overrideBaseUrl?: string) {
  const fromEnv = import.meta.env.VITE_COMFY_BASE_URL?.trim();
  const source = overrideBaseUrl?.trim() || fromEnv || DEFAULT_COMFY_BASE_URL;
  return normalizeBaseUrl(source);
}

function getFlowConfig(flow: ComfyFlow): ComfyFlowConfig {
  return FLOW_CONFIGS[flow];
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

async function interruptComfyExecution(baseUrl: string, auth?: EndpointAuthConfig) {
  try {
    await fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      headers: buildAuthHeaders(auth),
    });
  } catch {
    // Best-effort interrupt.
  }
}

async function clearComfyQueue(baseUrl: string, auth?: EndpointAuthConfig) {
  const headers = {
    "Content-Type": "application/json",
    ...buildAuthHeaders(auth),
  };

  try {
    await fetch(`${baseUrl}/queue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clear: true }),
    });
    return;
  } catch {
    // continue fallback
  }

  // Fallback payload used by some custom wrappers.
  try {
    await fetch(`${baseUrl}/queue`, {
      method: "POST",
      headers,
      body: JSON.stringify({ delete: "all" }),
    });
  } catch {
    // Best-effort queue clear.
  }
}

async function stopComfyExecution(baseUrl: string, auth?: EndpointAuthConfig) {
  await interruptComfyExecution(baseUrl, auth);
  await clearComfyQueue(baseUrl, auth);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Generation aborted", "AbortError");
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  if (!signal) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timer);
      cleanup();
      reject(new DOMException("Generation aborted", "AbortError"));
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function loadWorkflowTemplate(flow: ComfyFlow) {
  const cached = workflowTemplateCache[flow];
  if (cached) {
    return cached;
  }

  const { templatePath } = getFlowConfig(flow);
  const response = await fetch(templatePath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${templatePath} (${response.status})`);
  }

  const payload = (await response.json()) as ComfyWorkflow;
  workflowTemplateCache[flow] = payload;
  return payload;
}

function createWorkflowInstance(template: ComfyWorkflow) {
  return structuredClone(template) as ComfyWorkflow;
}

function setPromptOnNode(
  workflow: ComfyWorkflow,
  prompt: string,
  nodeId: string,
  strict: boolean,
) {
  const node = workflow[nodeId];
  if (!node || !node.inputs) {
    if (strict) {
      throw new Error(`Нода ${nodeId} не найдена в workflow.`);
    }
    return false;
  }
  // Prefer the field already present on the node schema.
  if ("value" in node.inputs) {
    node.inputs.value = prompt;
    return true;
  }
  if ("text" in node.inputs) {
    node.inputs.text = prompt;
    return true;
  }
  if ("string" in node.inputs) {
    node.inputs.string = prompt;
    return true;
  }
  // Fallback for nodes without explicit text field discovered yet.
  if (typeof node.inputs.text === "undefined") {
    node.inputs.text = prompt;
    return true;
  }
  if (strict) {
    throw new Error(`Нода ${nodeId} не содержит текстовый input (text/value/string).`);
  }
  return false;
}

function setPositivePrompt(
  workflow: ComfyWorkflow,
  prompt: string,
  nodeId: string = POSITIVE_PROMPT_NODE_ID,
) {
  setPromptOnNode(workflow, prompt, nodeId, true);
}

function setSize(
  workflow: ComfyWorkflow,
  width?: number,
  height?: number,
  nodeId: string = SIZE_NODE_ID,
) {
  if (!nodeId) return;
  if (!width || !height) return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.Xi = width;
  node.inputs.Xf = width;
  node.inputs.Yi = height;
  node.inputs.Yf = height;
}

function setSeed(
  workflow: ComfyWorkflow,
  seed?: number,
  nodeId: string = SEED_NODE_ID,
) {
  if (!nodeId) return;
  if (!Number.isFinite(seed)) return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.seed = Math.max(0, Math.floor(seed as number));
}

function setSliderValue(workflow: ComfyWorkflow, nodeId: string, value?: number) {
  if (!Number.isFinite(value)) return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.Xi = value;
  node.inputs.Xf = value;
}

function setBooleanValue(workflow: ComfyWorkflow, nodeId: string, value?: boolean) {
  if (typeof value !== "boolean") return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.value = value;
}

function setBooleanByTitle(
  workflow: ComfyWorkflow,
  titleTokens: string[],
  value?: boolean,
) {
  if (typeof value !== "boolean") return;
  const loweredTokens = titleTokens.map((token) => token.toLowerCase());
  for (const node of Object.values(workflow)) {
    const title = node._meta?.title?.toLowerCase() ?? "";
    if (!title || !node.inputs) continue;
    if (!loweredTokens.some((token) => title.includes(token))) continue;
    node.inputs.value = value;
  }
}

function setUpscaleFactorByTitle(workflow: ComfyWorkflow, value?: number) {
  if (!Number.isFinite(value)) return;
  const next = Number(value);
  for (const node of Object.values(workflow)) {
    const title = node._meta?.title?.toLowerCase() ?? "";
    if (!title || !title.includes("upscale factor") || !node.inputs) continue;
    if (typeof node.inputs.value === "number") {
      node.inputs.value = next;
    }
    if (typeof node.inputs.Xi === "number" || typeof node.inputs.Xf === "number") {
      node.inputs.Xi = next;
      node.inputs.Xf = next;
    }
  }
}

function setBooleanByExactTitle(workflow: ComfyWorkflow, title: string, value?: boolean) {
  if (typeof value !== "boolean") return;
  const target = title.toLowerCase();
  for (const node of Object.values(workflow)) {
    if (!node.inputs) continue;
    const nodeTitle = node._meta?.title?.toLowerCase() ?? "";
    if (nodeTitle !== target) continue;
    if (typeof node.inputs.value === "boolean") {
      node.inputs.value = value;
    }
  }
}

function setBooleanInputByExactTitle(
  workflow: ComfyWorkflow,
  title: string,
  inputName: string,
  value?: boolean,
) {
  if (typeof value !== "boolean") return;
  const target = title.toLowerCase();
  for (const node of Object.values(workflow)) {
    if (!node.inputs) continue;
    const nodeTitle = node._meta?.title?.toLowerCase() ?? "";
    if (nodeTitle !== target) continue;
    const current = node.inputs[inputName];
    if (typeof current === "boolean" || Array.isArray(current) || typeof current === "undefined") {
      node.inputs[inputName] = value;
    }
  }
}

function setInputByExactTitle(
  workflow: ComfyWorkflow,
  title: string,
  inputName: string,
  value: string | number | boolean,
) {
  const target = title.toLowerCase();
  for (const node of Object.values(workflow)) {
    if (!node.inputs) continue;
    const nodeTitle = node._meta?.title?.toLowerCase() ?? "";
    if (nodeTitle !== target) continue;
    node.inputs[inputName] = value;
  }
}

function hasNodeByExactTitle(workflow: ComfyWorkflow, title: string) {
  const target = title.toLowerCase();
  for (const node of Object.values(workflow)) {
    const nodeTitle = node._meta?.title?.toLowerCase() ?? "";
    if (nodeTitle === target) return true;
  }
  return false;
}

function setSliderByExactTitle(workflow: ComfyWorkflow, title: string, value?: number) {
  if (!Number.isFinite(value)) return;
  const target = title.toLowerCase();
  for (const node of Object.values(workflow)) {
    if (!node.inputs) continue;
    const nodeTitle = node._meta?.title?.toLowerCase() ?? "";
    if (nodeTitle !== target) continue;
    if (typeof node.inputs.Xi === "number") node.inputs.Xi = value;
    if (typeof node.inputs.Xf === "number") node.inputs.Xf = value;
    if (typeof node.inputs.value === "number") node.inputs.value = value;
  }
}

function setClipTextByExactTitle(
  workflow: ComfyWorkflow,
  title: string,
  value?: string,
) {
  if (!value?.trim()) return;
  const target = title.toLowerCase();
  for (const node of Object.values(workflow)) {
    if (node.class_type !== "CLIPTextEncode" || !node.inputs) continue;
    const nodeTitle = node._meta?.title?.toLowerCase() ?? "";
    if (nodeTitle !== target) continue;
    if (typeof node.inputs.text === "string") {
      node.inputs.text = value.trim();
    }
  }
}

function applyDetailing(
  workflow: ComfyWorkflow,
  detailing?: ComfyGenerationItem["detailing"],
  flowConfig: ComfyFlowConfig = FLOW_CONFIGS.base,
) {
  const setEnableDetailer = (part: string, enabled: boolean) => {
    setBooleanByExactTitle(workflow, `Enable ${part} Detailer`, enabled);
    setBooleanByExactTitle(workflow, `Enable ${part} prompt`, enabled);
  };

  const hasInpaintSwitch = hasNodeByExactTitle(workflow, "Inpaint?");
  const isI2I = Boolean(flowConfig.requiresReferenceImage);

  if (!detailing?.enabled || !detailing.level) {
    if (hasInpaintSwitch) {
      setBooleanByExactTitle(workflow, "Inpaint?", false);
    }
    // Prevent Impact Pack from executing with zero denoise on disabled paths.
    for (const part of ["Face", "Eyes", "Nose", "Lips", "Hands", "Nipples", "Vagina", "Penis"]) {
      setEnableDetailer(part, false);
    }
    if (isI2I) {
      // i2i templates may not expose the legacy "Inpaint?" switch; keep a conservative denoise baseline.
      setSliderByExactTitle(workflow, "Denoise", 0.55);
      setSliderByExactTitle(workflow, "Hi-Res Fix Denoise", 0.24);
      // Explicitly bypass all part-detailers in i2i when detailing is disabled.
      setBooleanInputByExactTitle(workflow, "Face bypass", "bypass", true);
      setBooleanInputByExactTitle(workflow, "Eyes bypass", "bypass", true);
      setBooleanInputByExactTitle(workflow, "Nose bypass", "bypass", true);
      setBooleanInputByExactTitle(workflow, "Lips bypass", "bypass", true);
      setBooleanInputByExactTitle(workflow, "Hands bypass", "bypass", true);
      setBooleanInputByExactTitle(workflow, "Nipples bypass", "bypass", true);
      setBooleanInputByExactTitle(workflow, "Vagina bypass", "bypass", true);
      setBooleanInputByExactTitle(workflow, "Penis bypass", "bypass", true);
    }
    return;
  }

  const i2iDenoiseMap: Record<DetailLevel, { base: number; hires: number }> = {
    soft: { base: 0.62, hires: 0.22 },
    medium: { base: 0.72, hires: 0.3 },
    strong: { base: 0.82, hires: 0.38 },
  };

  const levelMap: Record<
    DetailLevel,
    { face: number; eyes: number; nose: number; lips: number; hands: number }
  > = {
    soft: { face: 0.1, eyes: 0.1, nose: 0.12, lips: 0.13, hands: 0.16 },
    medium: { face: 0.14, eyes: 0.14, nose: 0.18, lips: 0.2, hands: 0.22 },
    strong: { face: 0.18, eyes: 0.18, nose: 0.22, lips: 0.24, hands: 0.28 },
  };
  const denoise = levelMap[detailing.level as DetailLevel];
  const enabledTargets =
    detailing.targets && detailing.targets.length > 0
      ? new Set<DetailTarget>(detailing.targets)
      : new Set<DetailTarget>(["face", "eyes", "nose", "lips", "hands"]);

  setEnableDetailer("Face", enabledTargets.has("face"));
  setEnableDetailer("Eyes", enabledTargets.has("eyes"));
  setEnableDetailer("Nose", enabledTargets.has("nose"));
  setEnableDetailer("Lips", enabledTargets.has("lips"));
  setEnableDetailer("Hands", enabledTargets.has("hands"));
  setEnableDetailer("Nipples", false);
  setEnableDetailer("Vagina", false);
  setEnableDetailer("Penis", false);

  if (hasInpaintSwitch) {
    setBooleanByExactTitle(workflow, "Inpaint?", true);
  }
  if (isI2I) {
    const i2iDenoise = i2iDenoiseMap[detailing.level as DetailLevel];
    setSliderByExactTitle(workflow, "Denoise", i2iDenoise.base);
    setSliderByExactTitle(workflow, "Hi-Res Fix Denoise", i2iDenoise.hires);
    // Mirror "Enable * Detailer" behavior using bypass switches present in i2i_2 flow.
    setBooleanInputByExactTitle(workflow, "Face bypass", "bypass", !enabledTargets.has("face"));
    setBooleanInputByExactTitle(workflow, "Eyes bypass", "bypass", !enabledTargets.has("eyes"));
    setBooleanInputByExactTitle(workflow, "Nose bypass", "bypass", !enabledTargets.has("nose"));
    setBooleanInputByExactTitle(workflow, "Lips bypass", "bypass", !enabledTargets.has("lips"));
    setBooleanInputByExactTitle(workflow, "Hands bypass", "bypass", !enabledTargets.has("hands"));
    // Always bypass erotic detailers in app flow.
    setBooleanInputByExactTitle(workflow, "Nipples bypass", "bypass", true);
    setBooleanInputByExactTitle(workflow, "Vagina bypass", "bypass", true);
    setBooleanInputByExactTitle(workflow, "Penis bypass", "bypass", true);
  }
  const minDenoise = 0.01;
  setSliderByExactTitle(workflow, "Denoise Face", enabledTargets.has("face") ? denoise.face : minDenoise);
  setSliderByExactTitle(workflow, "Denoise Eyes", enabledTargets.has("eyes") ? denoise.eyes : minDenoise);
  setSliderByExactTitle(workflow, "Denoise Nose", enabledTargets.has("nose") ? denoise.nose : minDenoise);
  setSliderByExactTitle(workflow, "Denoise Lips", enabledTargets.has("lips") ? denoise.lips : minDenoise);
  setSliderByExactTitle(workflow, "Denoise Hands", enabledTargets.has("hands") ? denoise.hands : minDenoise);

  // Explicitly disable erotic detail passes in persona generation flow.
  setSliderByExactTitle(workflow, "Denoise Nipples", minDenoise);
  setSliderByExactTitle(workflow, "Denoise Vagina", minDenoise);
  setSliderByExactTitle(workflow, "Denoise Penis", minDenoise);

  if (enabledTargets.has("face")) {
    setClipTextByExactTitle(workflow, flowConfig.detailPromptTitles.face, detailing.prompts?.face);
  }
  if (enabledTargets.has("eyes")) {
    setClipTextByExactTitle(workflow, flowConfig.detailPromptTitles.eyes, detailing.prompts?.eyes);
  }
  if (enabledTargets.has("nose")) {
    setClipTextByExactTitle(workflow, flowConfig.detailPromptTitles.nose, detailing.prompts?.nose);
  }
  if (enabledTargets.has("lips")) {
    setClipTextByExactTitle(workflow, flowConfig.detailPromptTitles.lips, detailing.prompts?.lips);
  }
  if (enabledTargets.has("hands")) {
    setClipTextByExactTitle(workflow, flowConfig.detailPromptTitles.hands, detailing.prompts?.hands);
  }
}

function setStyleImageFilename(
  workflow: ComfyWorkflow,
  filename?: string,
  nodeId: string = STYLE_IMAGE_NODE_ID,
) {
  if (!nodeId) return;
  if (!filename) return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.image = filename;
}

function setCompositionImageFilename(
  workflow: ComfyWorkflow,
  filename?: string,
  nodeId: string = COMPOSITION_IMAGE_NODE_ID,
) {
  if (!nodeId) return;
  if (!filename) return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.image = filename;
}

function setImageListSelectedPaths(
  workflow: ComfyWorkflow,
  filename?: string,
  nodeId?: string,
) {
  if (!nodeId || !filename) return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.selected_paths = JSON.stringify([filename]);
  if ("Select images" in node.inputs) {
    node.inputs["Select images"] = filename;
  }
}

function setLastGeneratedImageNodeFilename(
  workflow: ComfyWorkflow,
  filename?: string,
  nodeId: string = I2I_LAST_IMAGE_NODE_ID,
) {
  if (!nodeId || !filename) return;
  const node = workflow[nodeId];
  if (!node || !node.inputs) return;
  node.inputs.select_image = filename;
  node.inputs.image = `${filename} [input]`;
  if (typeof node.inputs.auto_refresh === "boolean") {
    node.inputs.auto_refresh = false;
  }
}

function setCheckpointName(workflow: ComfyWorkflow, checkpointName?: string) {
  const value = checkpointName?.trim();
  if (!value) return;
  for (const node of Object.values(workflow)) {
    if (!node.inputs || typeof node.inputs.ckpt_name !== "string") continue;
    node.inputs.ckpt_name = value;
  }
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

    // Force Comfy-side output compression to WEBP.
    node.inputs.extension = "webp";
    node.inputs.lossless_webp = false;
    node.inputs.quality_jpeg_or_webp = WEBP_QUALITY;
  }
}

function resolveOutputNodeGroups(
  workflow: ComfyWorkflow,
  outputTitlePreferences: string[],
) {
  const preview: string[] = [];
  const saverNodes: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type === "Image Saver") {
      saverNodes.push(nodeId);
    }
    const title = node._meta?.title ?? "";
    if (!title) continue;
    if (outputTitlePreferences.some((token) => title.includes(token))) {
      preview.push(nodeId);
    }
  }
  return { saver: saverNodes, preview };
}

function resolvePreferredOutputNodes(
  workflow: ComfyWorkflow,
  titleIncludes?: string[],
) {
  if (!titleIncludes || titleIncludes.length === 0) return [];
  const tokens = titleIncludes
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return [];

  const preferred: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const title = node._meta?.title?.toLowerCase() ?? "";
    if (!title) continue;
    if (tokens.some((token) => title.includes(token))) {
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

function createComfyDebugSnapshot(
  flow: ComfyFlow,
  baseUrl: string,
  workflow: ComfyWorkflow,
  item: ComfyGenerationItem,
) {
  const focusNodeIds = [
    "953",
    "679:572",
    "745",
    "891",
    "991",
    "984",
    "1050",
    "558",
    "949",
    "946",
    "489",
    "491",
    "492",
    "493",
    "494",
    "897",
    "907",
    "910",
    "908",
    "900",
    "935",
    "649",
    "933:1049",
    "923:1030",
    "923:850",
    "923:852",
    "947",
    "670",
  ];
  const focusNodes: Record<string, unknown> = {};

  for (const nodeId of focusNodeIds) {
    const node = workflow[nodeId];
    if (!node) {
      focusNodes[nodeId] = null;
      continue;
    }
    focusNodes[nodeId] = {
      class_type: node.class_type,
      title: node._meta?.title,
      inputs: node.inputs,
    };
  }

  return {
    createdAt: new Date().toISOString(),
    flow,
    baseUrl,
    item: {
      prompt: item.prompt,
      seed: item.seed,
      width: item.width,
      height: item.height,
      styleReferenceImage: item.styleReferenceImage ? "[provided]" : null,
      styleStrength: item.styleStrength,
      compositionStrength: item.compositionStrength,
      forceHiResFix: item.forceHiResFix,
      enableUpscaler: item.enableUpscaler,
      upscaleFactor: item.upscaleFactor,
      outputNodeTitleIncludes: item.outputNodeTitleIncludes,
      strictOutputNodeMatch: item.strictOutputNodeMatch,
      pickLatestImageOnly: item.pickLatestImageOnly,
      detailing: item.detailing,
    },
    focusNodes,
  };
}

function publishComfyDebugSnapshot(snapshot: unknown) {
  try {
    window.__TG_GF_LAST_COMFY_DEBUG__ = snapshot;
  } catch {
    // no-op
  }
  try {
    console.groupCollapsed("[tg-gf][comfy][debug] last workflow snapshot");
    console.log(snapshot);
    console.groupEnd();
  } catch {
    // no-op
  }
}

function dataUrlToBlob(dataUrl: string) {
  const [meta, payload] = dataUrl.split(",");
  if (!meta || !payload) {
    throw new Error("Некорректный data URL.");
  }
  const mimeMatch = /data:([^;]+);base64/.exec(meta);
  const mimeType = mimeMatch?.[1] ?? "application/octet-stream";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function sourceToBlob(source: string) {
  if (source.startsWith("data:")) {
    return dataUrlToBlob(source);
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить reference image (${response.status}).`);
  }
  return response.blob();
}

function extensionFromBlob(blob: Blob) {
  if (blob.type.includes("webp")) return "webp";
  if (blob.type.includes("jpeg")) return "jpg";
  return "png";
}

async function uploadReferenceImage(
  baseUrl: string,
  source: string,
  auth?: EndpointAuthConfig,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const blob = await sourceToBlob(source);
  const ext = extensionFromBlob(blob);
  const filename = `tg_gf_ref_${Date.now()}_${Math.floor(Math.random() * 100000)}.${ext}`;

  const form = new FormData();
  form.append("image", blob, filename);
  form.append("overwrite", "true");
  form.append("type", "input");

  const response = await fetch(`${baseUrl}/upload/image`, {
    method: "POST",
    headers: buildAuthHeaders(auth),
    body: form,
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ComfyUI /upload/image error (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as { name?: string };
  return (payload.name ?? filename).trim();
}

async function queuePrompt(
  baseUrl: string,
  workflow: ComfyWorkflow,
  auth?: EndpointAuthConfig,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const uiWorkflow = buildUiWorkflowForExtraPngInfo(workflow);

  const response = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(auth) },
    signal,
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
  signal?: AbortSignal,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= HISTORY_TIMEOUT_MS) {
    throwIfAborted(signal);
    const response = await fetch(
      `${baseUrl}/history/${encodeURIComponent(promptId)}`,
      {
        cache: "no-store",
        headers: buildAuthHeaders(auth),
        signal,
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

    await sleep(HISTORY_POLL_INTERVAL_MS, signal);
  }

  throw new Error("ComfyUI: таймаут ожидания результата генерации.");
}

function buildViewUrl(baseUrl: string, image: ComfyHistoryImage) {
  const filename = encodeURIComponent(image.filename);
  const subfolder = encodeURIComponent(image.subfolder ?? "");
  const type = encodeURIComponent(image.type ?? "output");
  return `${baseUrl}/view?filename=${filename}&subfolder=${subfolder}&type=${type}`;
}

function extractComfyViewParams(imageUrl: string) {
  try {
    const parsed = new URL(imageUrl, window.location.href);
    const filename = parsed.searchParams.get("filename")?.trim();
    if (!filename) return null;
    const subfolder = parsed.searchParams.get("subfolder")?.trim() ?? "";
    const type = parsed.searchParams.get("type")?.trim() || "output";
    return {
      baseUrl: `${parsed.protocol}//${parsed.host}`,
      filename,
      subfolder,
      type,
    };
  } catch {
    return null;
  }
}

function pickSeedFromValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    const match = value.match(/\bSeed\s*:\s*(\d+)\b/i);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    }
  }
  return undefined;
}

function extractMetaFromPayload(payload: unknown): ComfyImageGenerationMeta {
  const result: ComfyImageGenerationMeta = {};
  const root = payload as Record<string, unknown> | undefined;

  // Comfy prompt-style metadata.
  const promptGraph = root?.prompt as Record<string, unknown> | undefined;
  const seedNodeIds = [SEED_NODE_ID, I2I_SEED_NODE_ID];
  for (const nodeId of seedNodeIds) {
    const seedNode = promptGraph?.[nodeId] as Record<string, unknown> | undefined;
    const seedInputs = seedNode?.inputs as Record<string, unknown> | undefined;
    const seedFromGraph = pickSeedFromValue(seedInputs?.seed);
    if (seedFromGraph !== undefined) {
      result.seed = seedFromGraph;
      break;
    }
  }

  const promptNodeIds = [
    POSITIVE_PROMPT_NODE_ID,
    I2I_POSITIVE_PROMPT_NODE_ID,
    I2I_IMG2IMG_PROMPT_NODE_ID,
    I2I_INPAINT_POSITIVE_NODE_ID,
  ];
  for (const nodeId of promptNodeIds) {
    const promptNode = promptGraph?.[nodeId] as Record<string, unknown> | undefined;
    const promptInputs = promptNode?.inputs as Record<string, unknown> | undefined;
    const candidates = [promptInputs?.text, promptInputs?.value, promptInputs?.string];
    const promptFromGraph = candidates.find((value) => typeof value === "string" && value.trim()) as string | undefined;
    if (promptFromGraph) {
      result.prompt = promptFromGraph.trim();
      break;
    }
  }

  // Generic recursive fallback.
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) return;
    if (value === null || value === undefined) return;

    const directSeed = pickSeedFromValue(value);
    if (result.seed === undefined && directSeed !== undefined) {
      result.seed = directSeed;
    }
    if (typeof value === "string" && !result.prompt) {
      const trimmed = value.trim();
      if (trimmed.length > 16 && !/^https?:\/\//i.test(trimmed)) {
        result.prompt = trimmed;
      }
    }

    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);

    for (const [key, child] of Object.entries(obj)) {
      const normalizedKey = key.toLowerCase();
      if (result.seed === undefined && normalizedKey.includes("seed")) {
        const nextSeed = pickSeedFromValue(child);
        if (nextSeed !== undefined) result.seed = nextSeed;
      }
      if (
        !result.prompt &&
        (normalizedKey === "prompt" || normalizedKey === "positive" || normalizedKey === "text")
      ) {
        if (typeof child === "string" && child.trim()) {
          result.prompt = child.trim();
        }
      }
      visit(child, depth + 1);
    }
  };
  visit(payload, 0);

  return result;
}

export async function readComfyImageGenerationMeta(
  imageUrl: string,
  baseUrlOverride?: string,
  auth?: EndpointAuthConfig,
  signal?: AbortSignal,
) {
  const parsed = extractComfyViewParams(imageUrl);
  if (!parsed) return null;

  const baseUrl = getComfyBaseUrl(baseUrlOverride || parsed.baseUrl);
  const query = `filename=${encodeURIComponent(parsed.filename)}&subfolder=${encodeURIComponent(parsed.subfolder)}&type=${encodeURIComponent(parsed.type)}`;
  const candidates = [
    `${baseUrl}/view_metadata/${encodeURIComponent(parsed.filename)}?subfolder=${encodeURIComponent(parsed.subfolder)}&type=${encodeURIComponent(parsed.type)}`,
    `${baseUrl}/view_metadata?${query}`,
  ];

  for (const endpoint of candidates) {
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: buildAuthHeaders(auth),
        cache: "no-store",
        signal,
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      const meta = extractMetaFromPayload(payload);
      if (meta.seed !== undefined || meta.prompt) {
        return meta;
      }
    } catch {
      // continue fallback endpoints
    }
  }
  return null;
}

function collectImageUrls(
  baseUrl: string,
  workflow: ComfyWorkflow,
  historyEntry: ComfyHistoryEntry,
  outputTitlePreferences: string[],
  preferredTitleIncludes?: string[],
  strictPreferredMatch?: boolean,
  pickLatestImageOnly?: boolean,
) {
  const outputs = historyEntry.outputs ?? {};
  const nodeGroups = resolveOutputNodeGroups(workflow, outputTitlePreferences);
  const preferredNodes = resolvePreferredOutputNodes(workflow, preferredTitleIncludes);
  const preferredImages = preferredNodes.flatMap(
    (nodeId) => outputs[nodeId]?.images ?? [],
  );

  const saverImages = nodeGroups.saver.flatMap(
    (nodeId) => outputs[nodeId]?.images ?? [],
  );
  const previewImages = nodeGroups.preview.flatMap(
    (nodeId) => outputs[nodeId]?.images ?? [],
  );
  const fallbackImages = Object.values(outputs).flatMap(
    (nodeOutput) => nodeOutput.images ?? [],
  );
  const hasAnyImages =
    preferredImages.length > 0 ||
    previewImages.length > 0 ||
    saverImages.length > 0 ||
    fallbackImages.length > 0;

  const images =
    preferredImages.length > 0
      ? preferredImages
      : previewImages.length > 0
      ? previewImages
      : saverImages.length > 0
        ? saverImages
        : fallbackImages;

  if (
    strictPreferredMatch &&
    preferredNodes.length > 0 &&
    preferredImages.length === 0
  ) {
    if (!hasAnyImages) {
      throw new Error(
        "ComfyUI: не найден результат в целевом узле предпросмотра (Preview after Detailing).",
      );
    }
    console.warn(
      "ComfyUI: целевой preview-узел не вернул изображение; использован fallback output-узел.",
      {
        preferredNodes,
        availableOutputNodes: Object.keys(outputs),
      },
    );
  }

  const normalizedImages = pickLatestImageOnly && images.length > 0
    ? [images[images.length - 1]]
    : images;

  const urls = normalizedImages
    .filter((image) => Boolean(image?.filename))
    .map((image) => buildViewUrl(baseUrl, image));

  return Array.from(new Set(urls));
}

export async function generateComfyImages(
  itemsOrPrompts: Array<string | ComfyGenerationItem>,
  baseUrlOverride?: string,
  auth?: EndpointAuthConfig,
  onPromptResult?: (imageUrls: string[], index: number, total: number) => void | Promise<void>,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const normalizedItems = itemsOrPrompts
    .map((item) =>
      typeof item === "string"
        ? { prompt: item.trim(), flow: "base" as ComfyFlow }
        : {
            prompt: item.prompt.trim(),
            flow: item.flow ?? "base",
            width: item.width,
            height: item.height,
            seed: item.seed,
            checkpointName: item.checkpointName,
            styleReferenceImage: item.styleReferenceImage,
            styleStrength: item.styleStrength,
            compositionStrength: item.compositionStrength,
            forceHiResFix: item.forceHiResFix,
            enableUpscaler: item.enableUpscaler,
            upscaleFactor: item.upscaleFactor,
            hiresFixDenoise: item.hiresFixDenoise,
            colorFixStrength: item.colorFixStrength,
            outputNodeTitleIncludes: item.outputNodeTitleIncludes,
            strictOutputNodeMatch: item.strictOutputNodeMatch,
            pickLatestImageOnly: item.pickLatestImageOnly,
            detailing: item.detailing,
          },
    )
    .filter((item) => Boolean(item.prompt));

  if (normalizedItems.length === 0) return [];

  const baseUrl = getComfyBaseUrl(baseUrlOverride);
  const resultUrls: string[] = [];

  try {
    for (const [index, item] of normalizedItems.entries()) {
      throwIfAborted(signal);
      const flowConfig = getFlowConfig(item.flow);
      if (flowConfig.requiresReferenceImage && !item.styleReferenceImage) {
        throw new Error("i2i flow требует styleReferenceImage (исходное изображение).");
      }
      const template = await loadWorkflowTemplate(item.flow);
      const workflow = createWorkflowInstance(template);
      const promptNodeIds =
        flowConfig.positivePromptNodeIds && flowConfig.positivePromptNodeIds.length > 0
          ? flowConfig.positivePromptNodeIds
          : [flowConfig.positivePromptNodeId];
      let promptApplied = false;
      for (const nodeId of promptNodeIds) {
        promptApplied = setPromptOnNode(workflow, item.prompt, nodeId, false) || promptApplied;
      }
      if (flowConfig.promptFallbackNodeId) {
        promptApplied =
          setPromptOnNode(workflow, item.prompt, flowConfig.promptFallbackNodeId, false) ||
          promptApplied;
      }
      if (!promptApplied) {
        setPositivePrompt(workflow, item.prompt, flowConfig.positivePromptNodeId);
      }
      if (
        flowConfig.promptSwitchTitle &&
        flowConfig.promptSwitchInputName &&
        flowConfig.promptSwitchFallbackValue !== undefined
      ) {
        setInputByExactTitle(
          workflow,
          flowConfig.promptSwitchTitle,
          flowConfig.promptSwitchInputName,
          flowConfig.promptSwitchFallbackValue,
        );
      }
      if (flowConfig.sizeNodeId) {
        setSize(workflow, item.width, item.height, flowConfig.sizeNodeId);
      }
      if (flowConfig.seedNodeId) {
        setSeed(workflow, item.seed, flowConfig.seedNodeId);
      }
      setCheckpointName(workflow, item.checkpointName);
      if (flowConfig.styleStrengthNodeId) {
        setSliderValue(workflow, flowConfig.styleStrengthNodeId, item.styleStrength);
      }
      if (flowConfig.compositionStrengthNodeId) {
        setSliderValue(
          workflow,
          flowConfig.compositionStrengthNodeId,
          item.compositionStrength,
        );
      }
      if (flowConfig.hiresFixNodeId) {
        setBooleanValue(workflow, flowConfig.hiresFixNodeId, item.forceHiResFix);
      }
      setBooleanByTitle(workflow, ["enable upscaler", "use hi-res fix"], item.enableUpscaler);
      setUpscaleFactorByTitle(workflow, item.upscaleFactor);
      applyDetailing(workflow, item.detailing, flowConfig);
      setSliderByExactTitle(workflow, "Hi-Res Fix Denoise", item.hiresFixDenoise);
      setSliderByExactTitle(workflow, "Color Fix Strength", item.colorFixStrength);
      if (item.styleReferenceImage) {
        const uploadedFilename = await uploadReferenceImage(
          baseUrl,
          item.styleReferenceImage,
          auth,
          signal,
        );
        const styleNodeIds = new Set<string>();
        if (flowConfig.styleImageNodeId) styleNodeIds.add(flowConfig.styleImageNodeId);
        for (const nodeId of flowConfig.styleImageNodeIds ?? []) {
          styleNodeIds.add(nodeId);
        }
        for (const nodeId of styleNodeIds) {
          setStyleImageFilename(workflow, uploadedFilename, nodeId);
        }
        setLastGeneratedImageNodeFilename(workflow, uploadedFilename);
        setImageListSelectedPaths(workflow, uploadedFilename, flowConfig.imageListNodeId);
        if (
          flowConfig.sourceImageSwitchTitle &&
          flowConfig.sourceImageSwitchInputName &&
          flowConfig.sourceImageSwitchValue !== undefined
        ) {
          setInputByExactTitle(
            workflow,
            flowConfig.sourceImageSwitchTitle,
            flowConfig.sourceImageSwitchInputName,
            flowConfig.sourceImageSwitchValue,
          );
        }
        if (flowConfig.compositionImageNodeId) {
          setCompositionImageFilename(
            workflow,
            uploadedFilename,
            flowConfig.compositionImageNodeId,
          );
        }
      }
      sanitizeWorkflowForApi(workflow);
      publishComfyDebugSnapshot(
        createComfyDebugSnapshot(item.flow ?? "base", baseUrl, workflow, item),
      );
      const promptId = await queuePrompt(baseUrl, workflow, auth, signal);
      const historyEntry = await waitForHistory(baseUrl, promptId, auth, signal);
      const imageUrls = collectImageUrls(
        baseUrl,
        workflow,
        historyEntry,
        flowConfig.outputTitlePreferences,
        item.outputNodeTitleIncludes,
        item.strictOutputNodeMatch,
        item.pickLatestImageOnly,
      );
      if (onPromptResult) {
        await onPromptResult(imageUrls, index, normalizedItems.length);
      }
      resultUrls.push(...imageUrls);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      await stopComfyExecution(baseUrl, auth);
    } else {
      await stopComfyExecution(baseUrl, auth);
    }
    throw error;
  }

  return Array.from(new Set(resultUrls));
}

function parseCheckpointArray(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const candidates = [obj.models, obj.checkpoints, obj.data];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      const parsed = candidate
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean);
      if (parsed.length > 0) return parsed;
    }
  }
  return [];
}

function parseCheckpointObjectInfo(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const result = new Set<string>();
  for (const nodeDef of Object.values(payload as Record<string, unknown>)) {
    if (!nodeDef || typeof nodeDef !== "object") continue;
    const inputs = (nodeDef as Record<string, unknown>).input;
    if (!inputs || typeof inputs !== "object") continue;
    const required = (inputs as Record<string, unknown>).required;
    if (!required || typeof required !== "object") continue;
    const ckpt = (required as Record<string, unknown>).ckpt_name;
    if (!Array.isArray(ckpt) || ckpt.length === 0) continue;
    const choices = ckpt[0];
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      if (typeof choice === "string" && choice.trim()) {
        result.add(choice.trim());
      }
    }
  }
  return Array.from(result);
}

export async function listComfyCheckpoints(
  baseUrlOverride?: string,
  auth?: EndpointAuthConfig,
) {
  const baseUrl = getComfyBaseUrl(baseUrlOverride);
  const headers = buildAuthHeaders(auth);

  const endpoints = [
    `${baseUrl}/models/checkpoints`,
    `${baseUrl}/object_info`,
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers, cache: "no-store" });
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      const fromArray = parseCheckpointArray(payload);
      if (fromArray.length > 0) return fromArray.sort((a, b) => a.localeCompare(b));
      const fromObjectInfo = parseCheckpointObjectInfo(payload);
      if (fromObjectInfo.length > 0) {
        return fromObjectInfo.sort((a, b) => a.localeCompare(b));
      }
    } catch {
      // ignore and continue fallback endpoints
    }
  }

  return [];
}

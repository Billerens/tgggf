import { useEffect, useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { PersonaControlPayload } from "../personaDynamics";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  DiaryEntry,
  DiaryTag,
  ImageGenerationMeta,
  Persona,
  PersonaEvolutionApplyMode,
  PersonaEvolutionProfile,
  PersonaEvolutionState,
  PersonaMemory,
  PersonaRuntimeState,
} from "../types";
import type {
  LookEnhancePromptOverrides,
  LookEnhanceTarget,
} from "../ui/types";
import { dbApi } from "../db";
import { DIARY_TAG_PREFIXES } from "../diary";
import {
  applyPersonaEvolutionPatch,
  buildPersonaEvolutionPatchDeltaRows,
  buildPersonaEvolutionProfileDeltaRows,
  extractPersonaEvolutionBaselineProfile,
  formatPersonaEvolutionFieldLabel,
  selectAppliedPersonaEvolutionHistory,
  summarizePersonaEvolutionPatchFields,
} from "../personaEvolution";
import { resolveSharedEnhancePromptDefaults } from "../features/image-actions/enhancePromptDefaults";
import { splitAssistantContent } from "../messageContent";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { Dropdown, type DropdownOption } from "./Dropdown";
import type {
  NativeProactivitySimulationReport,
  NativeProactivitySimulationStageStatus,
} from "../features/mobile/oneToOneNativeRuntime";

interface ChatDetailsModalProps {
  open: boolean;
  chat: ChatSession | null;
  persona: Persona | null;
  messages: ChatMessage[];
  imageMetaByUrl: Record<string, ImageGenerationMeta>;
  memories: PersonaMemory[];
  diaryEntries: DiaryEntry[];
  runtimeState: PersonaRuntimeState | null;
  evolutionState: PersonaEvolutionState | null;
  settings: AppSettings;
  isAndroidRuntime: boolean;
  imageActionBusy: boolean;
  onEnhanceImage: (payload: {
    messageId: string;
    sourceUrl: string;
    meta?: ImageGenerationMeta;
  }, targetOverride?: LookEnhanceTarget, promptOverride?: string | LookEnhancePromptOverrides) => void;
  onRegenerateImage: (
    payload: {
      messageId: string;
      sourceUrl: string;
      meta?: ImageGenerationMeta;
    },
    promptOverride?: string,
  ) => void;
  onUpdateChatStyleStrength: (chatId: string, value: number | null) => void;
  onToggleNotificationsEnabled: (chatId: string, enabled: boolean) => void;
  onToggleDiaryEnabled: (chatId: string, enabled: boolean) => void;
  onToggleProactivityEnabled: (chatId: string, enabled: boolean) => void;
  onToggleEvolutionEnabled: (chatId: string, enabled: boolean) => void;
  onChangeEvolutionApplyMode: (
    chatId: string,
    applyMode: PersonaEvolutionApplyMode,
  ) => void;
  onAddPendingEvolution: (
    chatId: string,
    payload: {
      reason: string;
      patch: unknown;
    },
  ) => void;
  onUpdatePendingEvolution: (
    chatId: string,
    proposalId: string,
    payload: {
      reason: string;
      patch: unknown;
    },
  ) => void;
  onDeletePendingEvolution: (chatId: string, proposalId: string) => void;
  onApprovePendingEvolution: (chatId: string, proposalId: string) => void;
  onRejectPendingEvolution: (chatId: string, proposalId: string) => void;
  onUndoLastAppliedEvolution: (chatId: string) => void;
  onUpdateDiaryTags: (chatId: string, diaryEntryId: string, tags: string[]) => void;
  onDeleteDiaryEntry: (chatId: string, diaryEntryId: string) => void;
  onTestDiaryGeneration: (chatId: string) => Promise<DiaryEntry[]>;
  onTestProactivitySimulation: (
    chatId: string,
  ) => Promise<NativeProactivitySimulationReport | null>;
  onUpdateRuntimeState: (
    chatId: string,
    patch: Partial<
      Pick<
        PersonaRuntimeState,
        | "mood"
        | "trust"
        | "engagement"
        | "energy"
        | "lust"
        | "fear"
        | "affection"
        | "tension"
        | "relationshipType"
        | "relationshipDepth"
      >
    >,
  ) => void;
  onAddMemory: (
    chatId: string,
    payload: {
      layer: PersonaMemory["layer"];
      kind: PersonaMemory["kind"];
      content: string;
      salience: number;
    },
  ) => void;
  onUpdateMemory: (
    chatId: string,
    memoryId: string,
    patch: Partial<
      Pick<PersonaMemory, "layer" | "kind" | "content" | "salience">
    >,
  ) => void;
  onDeleteMemory: (chatId: string, memoryId: string) => void;
  onClose: () => void;
}

type DetailsTab = "attachments" | "status" | "proactivity" | "diaries";

interface ImageAttachment {
  src: string;
  alt: string;
  meta?: ImageGenerationMeta;
  messageId: string;
  sourceIndex?: number;
  role: ChatMessage["role"];
  createdAt: string;
}

const IMAGE_URL_REGEX = /(https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:\?[^\s)"'<>]*)?)/gi;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gi;

function parseIdbAssetId(value: string | undefined | null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

function extractImageAttachments(
  messages: ChatMessage[],
  imageMetaByUrl: Record<string, ImageGenerationMeta>,
): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];
  const known = new Set<string>();

  for (const message of messages) {
    const text = message.content ?? "";
    const explicitImageUrls = message.imageUrls ?? [];

    for (const [sourceIndex, srcRaw] of explicitImageUrls.entries()) {
      const src = (srcRaw ?? "").trim();
      if (!src) continue;
      const key = `${message.id}::${src}`;
      if (known.has(key)) continue;
      known.add(key);
      attachments.push({
        src,
        alt: "Generated image",
        meta: imageMetaByUrl[src],
        messageId: message.id,
        sourceIndex,
        role: message.role,
        createdAt: message.createdAt,
      });
    }

    for (const match of text.matchAll(MARKDOWN_IMAGE_REGEX)) {
      const alt = (match[1] ?? "").trim();
      const src = (match[2] ?? "").trim();
      if (!src) continue;
      const key = `${message.id}::${src}`;
      if (known.has(key)) continue;
      known.add(key);
      attachments.push({
        src,
        alt: alt || "Изображение",
        meta: imageMetaByUrl[src],
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
      });
    }

    for (const match of text.matchAll(IMAGE_URL_REGEX)) {
      const src = (match[1] ?? "").trim();
      if (!src) continue;
      const key = `${message.id}::${src}`;
      if (known.has(key)) continue;
      known.add(key);
      attachments.push({
        src,
        alt: "Изображение",
        meta: imageMetaByUrl[src],
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
      });
    }
  }

  return attachments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function formatDateTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatTime(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    timeStyle: "short",
  }).format(date);
}

function resolveDiaryDateKey(value: string) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  if (value.includes("T")) return value.slice(0, 10);
  return value.trim() || "unknown";
}

function formatDiaryDateGroupLabel(dateKey: string) {
  if (!dateKey || dateKey === "unknown") return "Без даты";
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "full" }).format(date);
}

function groupMemories(memories: PersonaMemory[]) {
  return {
    shortTerm: memories.filter((memory) => memory.layer === "short_term"),
    episodic: memories.filter((memory) => memory.layer === "episodic"),
    longTerm: memories.filter((memory) => memory.layer === "long_term"),
  };
}

function compactText(value: string | undefined, max = 220) {
  if (!value) return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function parsePersonaControlRaw(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PersonaControlPayload;
  } catch {
    return undefined;
  }
}

function getVisibleMessageText(message: ChatMessage) {
  if (message.role !== "assistant") return message.content ?? "";
  return splitAssistantContent(message.content).visibleText || message.content;
}

function getPersonaControlFromMessage(message: ChatMessage) {
  const fromRaw = parsePersonaControlRaw(message.personaControlRaw);
  if (fromRaw) return fromRaw;
  return splitAssistantContent(message.content).personaControl;
}

function findLastMessageByRole(messages: ChatMessage[], role: ChatMessage["role"]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === role) return message;
  }
  return undefined;
}

function formatDelta(label: string, value: number | undefined) {
  if (!Number.isFinite(value)) return null;
  const sign = value && value > 0 ? "+" : "";
  return `${label}: ${sign}${value}`;
}

function formatStateDelta(
  stateDelta: NonNullable<PersonaControlPayload["state_delta"]> | undefined,
) {
  if (!stateDelta) return "—";
  const parts: string[] = [];
  const trust = formatDelta("trust", stateDelta.trust);
  const engagement = formatDelta("engagement", stateDelta.engagement);
  const energy = formatDelta("energy", stateDelta.energy);
  const lust = formatDelta("lust", stateDelta.lust);
  const fear = formatDelta("fear", stateDelta.fear);
  const affection = formatDelta("affection", stateDelta.affection);
  const tension = formatDelta("tension", stateDelta.tension);
  const relationshipDepth = formatDelta("relationshipDepth", stateDelta.relationshipDepth);
  if (trust) parts.push(trust);
  if (engagement) parts.push(engagement);
  if (energy) parts.push(energy);
  if (lust) parts.push(lust);
  if (fear) parts.push(fear);
  if (affection) parts.push(affection);
  if (tension) parts.push(tension);
  if (stateDelta.mood) parts.push(`mood: ${stateDelta.mood}`);
  if (stateDelta.relationshipType) parts.push(`relationshipType: ${stateDelta.relationshipType}`);
  if (relationshipDepth) parts.push(relationshipDepth);
  if (stateDelta.relationshipStage) parts.push(`relationshipStage: ${stateDelta.relationshipStage}`);
  return parts.length > 0 ? parts.join(" | ") : "—";
}

function formatEvolutionPatchSummary(patch: PersonaEvolutionProfile) {
  const fields = summarizePersonaEvolutionPatchFields(patch, 12);
  if (fields.length === 0) return "patch";
  return fields.map((field) => formatPersonaEvolutionFieldLabel(field)).join(" • ");
}

function formatEvolutionPatchJson(patch: PersonaEvolutionProfile) {
  return JSON.stringify(patch, null, 2);
}

function parseEvolutionPatchJson(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      patch: null as unknown,
      error: "Patch JSON не может быть пустым.",
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        patch: null as unknown,
        error: "Patch JSON должен быть объектом.",
      };
    }
    return {
      patch: parsed,
      error: "",
    };
  } catch (error) {
    const message = (error as Error).message || "invalid_json";
    return {
      patch: null as unknown,
      error: `Невалидный JSON: ${message}`,
    };
  }
}

const DIARY_ALLOWED_PREFIXES = new Set<string>(DIARY_TAG_PREFIXES);

function normalizeDiaryTagInput(value: string): DiaryTag | "" {
  const normalized = value.trim();
  const separatorIndex = normalized.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= normalized.length - 1) return "";
  const prefix = normalized.slice(0, separatorIndex).trim().toLowerCase();
  if (!DIARY_ALLOWED_PREFIXES.has(prefix)) return "";
  const suffix = normalized.slice(separatorIndex + 1).trim().replace(/\s+/g, " ");
  if (!suffix) return "";
  return `${prefix}:${suffix}` as DiaryTag;
}

function formatDiaryTagForDisplay(tag: string) {
  const separatorIndex = tag.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= tag.length - 1) return tag;
  const prefix = tag.slice(0, separatorIndex).trim();
  const suffixRaw = tag.slice(separatorIndex + 1).trim();
  const suffix = suffixRaw.replace(/^[/\\|]+/, "").replace(/_/g, " ");
  return `${prefix}:${suffix}`;
}

function formatSimulationStageStatusLabel(status: NativeProactivitySimulationStageStatus) {
  if (status === "ok") return "ok";
  if (status === "skip") return "skip";
  if (status === "error") return "error";
  return "warn";
}

function renderDiaryMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<{ type: "heading" | "list" | "paragraph"; level?: number; lines: string[] }> = [];
  let paragraphLines: string[] = [];
  let listLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push({ type: "paragraph", lines: [...paragraphLines] });
    paragraphLines = [];
  };

  const flushList = () => {
    if (listLines.length === 0) return;
    blocks.push({ type: "list", lines: [...listLines] });
    listLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        lines: [headingMatch[2].trim()],
      });
      continue;
    }
    if (listMatch) {
      flushParagraph();
      listLines.push(listMatch[1].trim());
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraphLines.push(line.trim());
  }
  flushParagraph();
  flushList();

  return blocks.map((block, index) => {
    if (block.type === "heading") {
      const HeadingTag =
        block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
      return <HeadingTag key={`diary-block-${index}`}>{block.lines[0]}</HeadingTag>;
    }
    if (block.type === "list") {
      return (
        <ul key={`diary-block-${index}`}>
          {block.lines.map((line, lineIndex) => (
            <li key={`diary-li-${index}-${lineIndex}`}>{line}</li>
          ))}
        </ul>
      );
    }
    return <p key={`diary-block-${index}`}>{block.lines.join(" ")}</p>;
  });
}

type EditableRuntimeState = Pick<
  PersonaRuntimeState,
  | "mood"
  | "trust"
  | "engagement"
  | "energy"
  | "lust"
  | "fear"
  | "affection"
  | "tension"
  | "relationshipType"
  | "relationshipDepth"
>;

interface EditableMemoryDraft {
  layer: PersonaMemory["layer"];
  kind: PersonaMemory["kind"];
  content: string;
  salience: number;
}

interface PendingEvolutionPresentation {
  proposal: PersonaEvolutionState["pendingProposals"][number];
  deltaRows: ReturnType<typeof buildPersonaEvolutionPatchDeltaRows>;
}

type EvolutionHistoryDeltaMode = "applied" | "proposal" | "undo";

interface EvolutionHistoryPresentation {
  event: PersonaEvolutionState["history"][number];
  deltaRows: ReturnType<typeof buildPersonaEvolutionPatchDeltaRows>;
  deltaMode: EvolutionHistoryDeltaMode;
}

const RUNTIME_MOOD_OPTIONS: PersonaRuntimeState["mood"][] = [
  "calm",
  "warm",
  "playful",
  "focused",
  "analytical",
  "inspired",
  "annoyed",
  "upset",
  "angry",
];

const RUNTIME_RELATIONSHIP_TYPE_OPTIONS: PersonaRuntimeState["relationshipType"][] = [
  "neutral",
  "friendship",
  "romantic",
  "mentor",
  "playful",
];

const MANUAL_MEMORY_LAYER_OPTIONS: Array<PersonaMemory["layer"]> = [
  "long_term",
  "episodic",
];

const MANUAL_MEMORY_KIND_OPTIONS: Array<PersonaMemory["kind"]> = [
  "fact",
  "preference",
  "goal",
  "event",
];

const runtimeMoodDropdownOptions: DropdownOption[] = RUNTIME_MOOD_OPTIONS.map(
  (option) => ({
    value: option,
    label: option,
  }),
);

const runtimeRelationshipTypeDropdownOptions: DropdownOption[] =
  RUNTIME_RELATIONSHIP_TYPE_OPTIONS.map((option) => ({
    value: option,
    label: option,
  }));

const memoryLayerDropdownOptions: DropdownOption[] = MANUAL_MEMORY_LAYER_OPTIONS.map(
  (option) => ({
    value: option,
    label: option,
  }),
);

const memoryKindDropdownOptions: DropdownOption[] = MANUAL_MEMORY_KIND_OPTIONS.map(
  (option) => ({
    value: option,
    label: option,
  }),
);

const evolutionApplyModeDropdownOptions: DropdownOption[] = [
  { value: "manual", label: "manual" },
  { value: "auto", label: "auto" },
];

const DEFAULT_EVOLUTION_PATCH_TEMPLATE = `{
  "advanced": {
    "behavior": {
      "initiative": 56
    }
  }
}`;

function toEditableRuntimeState(value: PersonaRuntimeState): EditableRuntimeState {
  return {
    mood: value.mood,
    trust: value.trust,
    engagement: value.engagement,
    energy: value.energy,
    lust: value.lust,
    fear: value.fear,
    affection: value.affection,
    tension: value.tension,
    relationshipType: value.relationshipType,
    relationshipDepth: value.relationshipDepth,
  };
}

function clampMetric(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function ChatDetailsModal({
  open,
  chat,
  persona,
  messages,
  imageMetaByUrl,
  memories,
  diaryEntries,
  runtimeState,
  evolutionState,
  settings,
  isAndroidRuntime,
  imageActionBusy,
  onEnhanceImage,
  onRegenerateImage,
  onUpdateChatStyleStrength,
  onToggleNotificationsEnabled,
  onToggleDiaryEnabled,
  onToggleProactivityEnabled,
  onToggleEvolutionEnabled,
  onChangeEvolutionApplyMode,
  onAddPendingEvolution,
  onUpdatePendingEvolution,
  onDeletePendingEvolution,
  onApprovePendingEvolution,
  onRejectPendingEvolution,
  onUndoLastAppliedEvolution,
  onUpdateDiaryTags,
  onDeleteDiaryEntry,
  onTestDiaryGeneration,
  onTestProactivitySimulation,
  onUpdateRuntimeState,
  onAddMemory,
  onUpdateMemory,
  onDeleteMemory,
  onClose,
}: ChatDetailsModalProps) {
  const [tab, setTab] = useState<DetailsTab>("attachments");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<ImageGenerationMeta | undefined>(undefined);
  const [previewAttachment, setPreviewAttachment] = useState<ImageAttachment | null>(null);
  const [resolvedImageBySource, setResolvedImageBySource] = useState<
    Record<string, string>
  >({});
  const [stateLocked, setStateLocked] = useState(true);
  const [runtimeDraft, setRuntimeDraft] = useState<EditableRuntimeState | null>(
    runtimeState ? toEditableRuntimeState(runtimeState) : null,
  );
  const [manualMemoryLayer, setManualMemoryLayer] = useState<PersonaMemory["layer"]>(
    "long_term",
  );
  const [manualMemoryKind, setManualMemoryKind] = useState<PersonaMemory["kind"]>("fact");
  const [manualMemorySalience, setManualMemorySalience] = useState(0.82);
  const [manualMemoryContent, setManualMemoryContent] = useState("");
  const [manualEvolutionReason, setManualEvolutionReason] = useState("");
  const [manualEvolutionPatchText, setManualEvolutionPatchText] = useState(
    DEFAULT_EVOLUTION_PATCH_TEMPLATE,
  );
  const [manualEvolutionError, setManualEvolutionError] = useState<string | null>(
    null,
  );
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryEditDraft, setMemoryEditDraft] = useState<EditableMemoryDraft | null>(
    null,
  );
  const [editingEvolutionProposalId, setEditingEvolutionProposalId] = useState<
    string | null
  >(null);
  const [evolutionEditReason, setEvolutionEditReason] = useState("");
  const [evolutionEditPatchText, setEvolutionEditPatchText] = useState(
    DEFAULT_EVOLUTION_PATCH_TEMPLATE,
  );
  const [evolutionEditError, setEvolutionEditError] = useState<string | null>(
    null,
  );
  const [useGlobalStyleStrength, setUseGlobalStyleStrength] = useState(
    typeof chat?.chatStyleStrength !== "number",
  );
  const [chatStyleStrengthDraft, setChatStyleStrengthDraft] = useState(
    typeof chat?.chatStyleStrength === "number"
      ? chat.chatStyleStrength
      : settings.chatStyleStrength,
  );
  const [selectedDiaryEntryId, setSelectedDiaryEntryId] = useState<string | null>(
    null,
  );
  const [diaryTagDraft, setDiaryTagDraft] = useState("");
  const [testDiaryBusy, setTestDiaryBusy] = useState(false);
  const [testDiaryMessage, setTestDiaryMessage] = useState<string | null>(null);
  const [testDiaryEntries, setTestDiaryEntries] = useState<DiaryEntry[]>([]);
  const [testProactivityBusy, setTestProactivityBusy] = useState(false);
  const [testProactivityMessage, setTestProactivityMessage] = useState<string | null>(null);
  const [testProactivityReport, setTestProactivityReport] =
    useState<NativeProactivitySimulationReport | null>(null);
  const [selectedDiaryFilterTags, setSelectedDiaryFilterTags] = useState<string[]>([]);
  const [diaryFilterPickerValue, setDiaryFilterPickerValue] = useState("");
  const [isMobileDiaryViewport, setIsMobileDiaryViewport] = useState(false);
  const [mobileDiaryDetailOpen, setMobileDiaryDetailOpen] = useState(false);
  const attachments = useMemo(
    () => extractImageAttachments(messages, imageMetaByUrl),
    [messages, imageMetaByUrl],
  );
  const diaryFilterTagOptions = useMemo(() => {
    const stats = new Map<string, number>();
    for (const entry of diaryEntries) {
      for (const tag of entry.tags) {
        if (tag.startsWith("date:")) continue;
        stats.set(tag, (stats.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(stats.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.tag.localeCompare(b.tag, "ru");
      });
  }, [diaryEntries]);
  const diaryFilterPickerOptions = useMemo<DropdownOption[]>(
    () =>
      diaryFilterTagOptions
        .filter((option) => !selectedDiaryFilterTags.includes(option.tag))
        .map((option) => ({
          value: option.tag,
          label: formatDiaryTagForDisplay(option.tag),
          description: `${option.count} шт.`,
        })),
    [diaryFilterTagOptions, selectedDiaryFilterTags],
  );
  const filteredDiaryEntries = useMemo(() => {
    if (selectedDiaryFilterTags.length === 0) return diaryEntries;
    const selectedSet = new Set(selectedDiaryFilterTags);
    return diaryEntries.filter((entry) =>
      entry.tags.some((tag) => selectedSet.has(tag)),
    );
  }, [diaryEntries, selectedDiaryFilterTags]);
  const groupedDiaryEntries = useMemo(() => {
    const byDate = new Map<string, DiaryEntry[]>();
    const ordered = [...filteredDiaryEntries].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    for (const entry of ordered) {
      const dateKey = resolveDiaryDateKey(entry.createdAt);
      const bucket = byDate.get(dateKey) ?? [];
      bucket.push(entry);
      byDate.set(dateKey, bucket);
    }
    return Array.from(byDate.entries()).map(([dateKey, entries]) => ({
      dateKey,
      label: formatDiaryDateGroupLabel(dateKey),
      entries,
    }));
  }, [filteredDiaryEntries]);
  const selectedDiaryEntry = useMemo(() => {
    if (filteredDiaryEntries.length === 0) return null;
    const selected = selectedDiaryEntryId
      ? filteredDiaryEntries.find((entry) => entry.id === selectedDiaryEntryId)
      : undefined;
    return selected ?? filteredDiaryEntries[0] ?? null;
  }, [filteredDiaryEntries, selectedDiaryEntryId]);
  const diaryEnabled = Boolean(chat?.diaryConfig?.enabled);
  const notificationsEnabled =
    typeof chat?.notificationsEnabled === "boolean"
      ? chat.notificationsEnabled
      : true;
  const proactivityEnabled = Boolean(chat?.proactivityConfig?.enabled);
  const evolutionEnabled = Boolean(chat?.evolutionConfig?.enabled);
  const evolutionApplyMode: PersonaEvolutionApplyMode =
    chat?.evolutionConfig?.applyMode === "auto" ? "auto" : "manual";
  const evolutionPending = evolutionState?.pendingProposals ?? [];
  const evolutionHistory = evolutionState?.history ?? [];
  const evolutionSnapshotProfile = useMemo(() => {
    if (evolutionState?.currentProfile) return evolutionState.currentProfile;
    if (evolutionState?.baselineProfile) return evolutionState.baselineProfile;
    if (persona) return extractPersonaEvolutionBaselineProfile(persona);
    return undefined;
  }, [evolutionState?.currentProfile, evolutionState?.baselineProfile, persona]);
  const evolutionSnapshotLabel = evolutionState?.currentProfile
    ? "currentProfile"
    : evolutionState?.baselineProfile
      ? "baselineProfile"
      : persona
        ? "persona baseline"
        : "snapshot unavailable";
  const pendingEvolutionPresentation = useMemo<PendingEvolutionPresentation[]>(
    () =>
      evolutionPending.map((proposal) => ({
        proposal,
        deltaRows: evolutionSnapshotProfile
          ? buildPersonaEvolutionPatchDeltaRows(
              evolutionSnapshotProfile,
              proposal.patch,
              12,
            )
          : [],
      })),
    [evolutionPending, evolutionSnapshotProfile],
  );
  const appliedEvolutionHistory = useMemo(
    () => selectAppliedPersonaEvolutionHistory(evolutionHistory),
    [evolutionHistory],
  );
  const evolutionHistoryPresentation = useMemo<EvolutionHistoryPresentation[]>(
    () => {
      if (!evolutionState) return [];
      let activeApplied: Array<{
        id: string;
        patch: PersonaEvolutionProfile;
      }> = [];
      let currentProfile = evolutionState.baselineProfile;
      const rows: EvolutionHistoryPresentation[] = [];

      for (const event of evolutionState.history) {
        const beforeProfile = currentProfile;
        if (event.status === "applied") {
          const afterProfile = applyPersonaEvolutionPatch(beforeProfile, event.patch);
          rows.push({
            event,
            deltaMode: "applied",
            deltaRows: buildPersonaEvolutionPatchDeltaRows(
              beforeProfile,
              event.patch,
              12,
            ),
          });
          activeApplied = [...activeApplied, { id: event.id, patch: event.patch }];
          currentProfile = afterProfile;
          continue;
        }

        if (event.status === "rejected") {
          rows.push({
            event,
            deltaMode: "proposal",
            deltaRows: buildPersonaEvolutionPatchDeltaRows(
              beforeProfile,
              event.patch,
              12,
            ),
          });
          continue;
        }

        const targetId = event.targetEventId?.trim();
        if (targetId) {
          activeApplied = activeApplied.filter((item) => item.id !== targetId);
        }
        const afterProfile = activeApplied.reduce(
          (profile, activeEvent) =>
            applyPersonaEvolutionPatch(profile, activeEvent.patch),
          evolutionState.baselineProfile,
        );
        rows.push({
          event,
          deltaMode: "undo",
          deltaRows: buildPersonaEvolutionProfileDeltaRows(
            beforeProfile,
            afterProfile,
            12,
          ),
        });
        currentProfile = afterProfile;
      }

      return rows;
    },
    [evolutionState],
  );
  const canUndoEvolution = Boolean(chat?.id) && appliedEvolutionHistory.length > 0;
  const memoryByLayer = useMemo(() => groupMemories(memories), [memories]);
  const lastUserMessage = useMemo(() => findLastMessageByRole(messages, "user"), [messages]);
  const lastAssistantMessage = useMemo(() => findLastMessageByRole(messages, "assistant"), [messages]);
  const lastControl = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      const control = getPersonaControlFromMessage(message);
      if (!control) continue;
      return { message, control };
    }
    return null;
  }, [messages]);
  const lastRelationshipProposalMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (!message.relationshipProposalType && !message.relationshipProposalStage) continue;
      return message;
    }
    return undefined;
  }, [messages]);
  const lastUserPreview = useMemo(
    () => compactText(lastUserMessage ? getVisibleMessageText(lastUserMessage) : "", 260) || "—",
    [lastUserMessage],
  );
  const lastAssistantPreview = useMemo(
    () => compactText(lastAssistantMessage ? getVisibleMessageText(lastAssistantMessage) : "", 260) || "—",
    [lastAssistantMessage],
  );
  const summaryPreview = useMemo(
    () => compactText(chat?.conversationSummary?.trim() || "", 260) || "—",
    [chat?.conversationSummary],
  );
  const summaryFactsCount = chat?.summaryFacts?.length ?? 0;
  const summaryGoalsCount = chat?.summaryGoals?.length ?? 0;
  const summaryOpenThreadsCount = chat?.summaryOpenThreads?.length ?? 0;
  const summaryAgreementsCount = chat?.summaryAgreements?.length ?? 0;
  const runtimeComparable = runtimeState ? toEditableRuntimeState(runtimeState) : null;
  const canSaveRuntimeDraft =
    Boolean(chat?.id) &&
    !stateLocked &&
    Boolean(runtimeComparable) &&
    Boolean(runtimeDraft) &&
    runtimeDraft !== null &&
    runtimeComparable !== null &&
    JSON.stringify(runtimeDraft) !== JSON.stringify(runtimeComparable);
  const canAddManualMemory =
    Boolean(chat?.id) && !stateLocked && manualMemoryContent.trim().length > 0;
  const canSaveMemoryEdit =
    Boolean(chat?.id) &&
    !stateLocked &&
    Boolean(editingMemoryId) &&
    Boolean(memoryEditDraft?.content.trim().length);
  const canAddManualEvolutionProposal =
    Boolean(chat?.id) &&
    !stateLocked &&
    manualEvolutionReason.trim().length > 0 &&
    manualEvolutionPatchText.trim().length > 0;
  const canSaveEvolutionEdit =
    Boolean(chat?.id) &&
    !stateLocked &&
    Boolean(editingEvolutionProposalId) &&
    evolutionEditReason.trim().length > 0 &&
    evolutionEditPatchText.trim().length > 0;
  const previewResolvedMeta = previewAttachment
    ? previewMeta ?? imageMetaByUrl[previewAttachment.src]
    : previewMeta;
  const previewEnhancePromptDefaults = previewAttachment
    ? resolveSharedEnhancePromptDefaults(persona, previewResolvedMeta)
    : undefined;

  useEffect(() => {
    setUseGlobalStyleStrength(typeof chat?.chatStyleStrength !== "number");
    setChatStyleStrengthDraft(
      typeof chat?.chatStyleStrength === "number"
        ? chat.chatStyleStrength
        : settings.chatStyleStrength,
    );
  }, [chat?.id, chat?.chatStyleStrength, settings.chatStyleStrength]);

  useEffect(() => {
    setStateLocked(true);
    setRuntimeDraft(runtimeState ? toEditableRuntimeState(runtimeState) : null);
    setEditingMemoryId(null);
    setMemoryEditDraft(null);
    setEditingEvolutionProposalId(null);
    setEvolutionEditReason("");
    setEvolutionEditPatchText(DEFAULT_EVOLUTION_PATCH_TEMPLATE);
    setEvolutionEditError(null);
    setManualEvolutionReason("");
    setManualEvolutionPatchText(DEFAULT_EVOLUTION_PATCH_TEMPLATE);
    setManualEvolutionError(null);
  }, [chat?.id, runtimeState]);

  useEffect(() => {
    if (filteredDiaryEntries.length === 0) {
      setSelectedDiaryEntryId(null);
      setMobileDiaryDetailOpen(false);
      return;
    }
    if (
      selectedDiaryEntryId &&
      filteredDiaryEntries.some((entry) => entry.id === selectedDiaryEntryId)
    ) {
      return;
    }
    setSelectedDiaryEntryId(filteredDiaryEntries[0]?.id ?? null);
  }, [chat?.id, filteredDiaryEntries, selectedDiaryEntryId]);

  useEffect(() => {
    setTestDiaryBusy(false);
    setTestDiaryMessage(null);
    setTestDiaryEntries([]);
    setTestProactivityBusy(false);
    setTestProactivityMessage(null);
    setTestProactivityReport(null);
    setSelectedDiaryFilterTags([]);
    setDiaryFilterPickerValue("");
    setMobileDiaryDetailOpen(false);
  }, [chat?.id]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const syncViewport = () => {
      setIsMobileDiaryViewport(mediaQuery.matches);
    };
    syncViewport();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncViewport);
      return () => mediaQuery.removeEventListener("change", syncViewport);
    }
    mediaQuery.addListener(syncViewport);
    return () => mediaQuery.removeListener(syncViewport);
  }, []);

  useEffect(() => {
    if (!isMobileDiaryViewport) {
      setMobileDiaryDetailOpen(false);
    }
  }, [isMobileDiaryViewport]);

  useEffect(() => {
    const allowed = new Set(diaryFilterTagOptions.map((option) => option.tag));
    setSelectedDiaryFilterTags((current) =>
      current.filter((tag) => allowed.has(tag)),
    );
    setDiaryFilterPickerValue((current) =>
      allowed.has(current) ? current : "",
    );
  }, [diaryFilterTagOptions]);

  useEffect(() => {
    let cancelled = false;
    const loadAttachmentAssets = async () => {
      const refsById = new Map<string, string[]>();
      const nextResolved: Record<string, string> = {};
      for (const attachment of attachments) {
        const sourceUrl = attachment.src.trim();
        if (!sourceUrl) continue;
        const assetId = parseIdbAssetId(sourceUrl);
        if (!assetId) {
          nextResolved[sourceUrl] = sourceUrl;
          continue;
        }
        const bucket = refsById.get(assetId) ?? [];
        bucket.push(sourceUrl);
        refsById.set(assetId, bucket);
      }
      if (refsById.size > 0) {
        const unresolved = new Set(refsById.keys());
        const maxAttempts = 8;
        for (
          let attempt = 0;
          attempt < maxAttempts && unresolved.size > 0;
          attempt += 1
        ) {
          const ids = Array.from(unresolved);
          const assets = await dbApi.getImageAssets(ids);
          const assetById = Object.fromEntries(
            assets.map((asset) => [asset.id, asset.dataUrl]),
          );
          for (const [assetId, sourceUrls] of refsById.entries()) {
            const resolvedDataUrl = assetById[assetId] ?? "";
            if (!resolvedDataUrl) continue;
            unresolved.delete(assetId);
            for (const sourceUrl of sourceUrls) {
              nextResolved[sourceUrl] = resolvedDataUrl;
            }
          }
          if (unresolved.size > 0 && attempt < maxAttempts - 1) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, 320);
            });
          }
        }
        for (const unresolvedId of unresolved) {
          const sourceUrls = refsById.get(unresolvedId) ?? [];
          for (const sourceUrl of sourceUrls) {
            nextResolved[sourceUrl] = "";
          }
        }
      }
      if (!cancelled) {
        setResolvedImageBySource(nextResolved);
      }
    };
    void loadAttachmentAssets();
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  useEffect(() => {
    if (!previewAttachment) return;
    const message = messages.find((candidate) => candidate.id === previewAttachment.messageId);
    if (!message) return;
    const imageUrls = message.imageUrls ?? [];
    if (imageUrls.length === 0) return;

    const preferredByIndex =
      typeof previewAttachment.sourceIndex === "number" &&
      previewAttachment.sourceIndex >= 0
        ? imageUrls[previewAttachment.sourceIndex] ?? ""
        : "";
    const preferredBySource = imageUrls.includes(previewAttachment.src)
      ? previewAttachment.src
      : "";
    const nextSource =
      preferredByIndex || preferredBySource || imageUrls[0] || previewSrc || "";
    const resolvedPreview =
      resolvedImageBySource[nextSource] ??
      (parseIdbAssetId(nextSource) ? "" : nextSource);

    if (!nextSource) {
      return;
    }
    if (resolvedPreview && resolvedPreview === previewSrc) {
      return;
    }

    setPreviewSrc(resolvedPreview || null);
    setPreviewMeta(imageMetaByUrl[nextSource]);
    setPreviewAttachment((prev) =>
      prev
        ? {
            ...prev,
            src: nextSource,
            meta: imageMetaByUrl[nextSource],
          }
        : prev,
    );
  }, [
    messages,
    imageMetaByUrl,
    previewAttachment,
    previewSrc,
    resolvedImageBySource,
  ]);

  function updateRuntimeMetric(
    key:
      | "trust"
      | "engagement"
      | "energy"
      | "lust"
      | "fear"
      | "affection"
      | "tension"
      | "relationshipDepth",
    raw: string,
  ) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    setRuntimeDraft((current) =>
      current
        ? {
            ...current,
            [key]: clampMetric(parsed),
          }
        : current,
    );
  }

  function handleSaveRuntimeState() {
    if (!chat?.id || !runtimeDraft) return;
    onUpdateRuntimeState(chat.id, runtimeDraft);
  }

  function handleAddManualMemory() {
    if (!chat?.id || stateLocked) return;
    const content = manualMemoryContent.trim();
    if (!content) return;
    onAddMemory(chat.id, {
      layer: manualMemoryLayer,
      kind: manualMemoryKind,
      content,
      salience: manualMemorySalience,
    });
    setManualMemoryContent("");
  }

  function startMemoryEdit(memory: PersonaMemory) {
    if (stateLocked) return;
    setEditingMemoryId(memory.id);
    setMemoryEditDraft({
      layer: memory.layer,
      kind: memory.kind,
      content: memory.content,
      salience: memory.salience,
    });
  }

  function handleCancelMemoryEdit() {
    setEditingMemoryId(null);
    setMemoryEditDraft(null);
  }

  function handleSaveMemoryEdit() {
    if (!chat?.id || stateLocked || !editingMemoryId || !memoryEditDraft) return;
    onUpdateMemory(chat.id, editingMemoryId, {
      layer: memoryEditDraft.layer,
      kind: memoryEditDraft.kind,
      content: memoryEditDraft.content,
      salience: memoryEditDraft.salience,
    });
    setEditingMemoryId(null);
    setMemoryEditDraft(null);
  }

  function handleDeleteMemory(memoryId: string) {
    if (!chat?.id || stateLocked) return;
    onDeleteMemory(chat.id, memoryId);
    if (editingMemoryId === memoryId) {
      setEditingMemoryId(null);
      setMemoryEditDraft(null);
    }
  }

  function handleAddPendingEvolutionProposal() {
    if (!chat?.id || stateLocked) return;
    const reason = manualEvolutionReason.trim();
    if (!reason) {
      setManualEvolutionError("Укажите reason для proposal.");
      return;
    }
    const parsed = parseEvolutionPatchJson(manualEvolutionPatchText);
    if (!parsed.patch) {
      setManualEvolutionError(parsed.error || "Невалидный patch JSON.");
      return;
    }
    onAddPendingEvolution(chat.id, {
      reason,
      patch: parsed.patch,
    });
    setManualEvolutionReason("");
    setManualEvolutionPatchText(DEFAULT_EVOLUTION_PATCH_TEMPLATE);
    setManualEvolutionError(null);
  }

  function startPendingEvolutionEdit(proposal: PersonaEvolutionState["pendingProposals"][number]) {
    if (stateLocked) return;
    setEditingEvolutionProposalId(proposal.id);
    setEvolutionEditReason(proposal.reason || "");
    setEvolutionEditPatchText(formatEvolutionPatchJson(proposal.patch));
    setEvolutionEditError(null);
  }

  function handleCancelPendingEvolutionEdit() {
    setEditingEvolutionProposalId(null);
    setEvolutionEditReason("");
    setEvolutionEditPatchText(DEFAULT_EVOLUTION_PATCH_TEMPLATE);
    setEvolutionEditError(null);
  }

  function handleSavePendingEvolutionEdit() {
    if (!chat?.id || stateLocked || !editingEvolutionProposalId) return;
    const reason = evolutionEditReason.trim();
    if (!reason) {
      setEvolutionEditError("Укажите reason для proposal.");
      return;
    }
    const parsed = parseEvolutionPatchJson(evolutionEditPatchText);
    if (!parsed.patch) {
      setEvolutionEditError(parsed.error || "Невалидный patch JSON.");
      return;
    }
    onUpdatePendingEvolution(chat.id, editingEvolutionProposalId, {
      reason,
      patch: parsed.patch,
    });
    setEditingEvolutionProposalId(null);
    setEvolutionEditReason("");
    setEvolutionEditPatchText(DEFAULT_EVOLUTION_PATCH_TEMPLATE);
    setEvolutionEditError(null);
  }

  function handleDeletePendingEvolutionProposal(proposalId: string) {
    if (!chat?.id || stateLocked) return;
    onDeletePendingEvolution(chat.id, proposalId);
    if (editingEvolutionProposalId === proposalId) {
      setEditingEvolutionProposalId(null);
      setEvolutionEditReason("");
      setEvolutionEditPatchText(DEFAULT_EVOLUTION_PATCH_TEMPLATE);
      setEvolutionEditError(null);
    }
  }

  function handleAddDiaryTag() {
    if (!chat?.id || !selectedDiaryEntry) return;
    const normalizedTag = normalizeDiaryTagInput(diaryTagDraft);
    if (!normalizedTag) return;
    if (selectedDiaryEntry.tags.includes(normalizedTag)) {
      setDiaryTagDraft("");
      return;
    }
    onUpdateDiaryTags(chat.id, selectedDiaryEntry.id, [
      ...selectedDiaryEntry.tags,
      normalizedTag,
    ]);
    setDiaryTagDraft("");
  }

  function handleRemoveDiaryTag(tag: string) {
    if (!chat?.id || !selectedDiaryEntry) return;
    onUpdateDiaryTags(
      chat.id,
      selectedDiaryEntry.id,
      selectedDiaryEntry.tags.filter((currentTag) => currentTag !== tag),
    );
  }

  async function handleTestDiaryGeneration() {
    if (!chat?.id || testDiaryBusy) return;
    setTestDiaryBusy(true);
    setTestDiaryMessage(null);
    try {
      const generatedEntries = await onTestDiaryGeneration(chat.id);
      if (generatedEntries.length === 0) {
        setTestDiaryEntries([]);
        setTestDiaryMessage(
          "Тест не создал записи: мало контента или модель решила пропустить дневник.",
        );
        return;
      }
      setTestDiaryEntries(generatedEntries);
      setTestDiaryMessage(
        `Тестовые записи сгенерированы: ${generatedEntries.length}. В базу они не сохранены.`,
      );
    } catch (error) {
      setTestDiaryEntries([]);
      setTestDiaryMessage((error as Error).message || "Не удалось выполнить тест генерации.");
    } finally {
      setTestDiaryBusy(false);
    }
  }

  async function handleTestProactivitySimulation() {
    if (!chat?.id || testProactivityBusy || !isAndroidRuntime) return;
    setTestProactivityBusy(true);
    setTestProactivityMessage(null);
    try {
      const report = await onTestProactivitySimulation(chat.id);
      if (!report) {
        setTestProactivityReport(null);
        setTestProactivityMessage(
          "Симуляция недоступна: нет ответа от Android runtime.",
        );
        return;
      }
      setTestProactivityReport(report);
      setTestProactivityMessage(
        `Симуляция завершена: этапов ${report.stages.length}. Ничего не сохранено.`,
      );
    } catch (error) {
      setTestProactivityReport(null);
      setTestProactivityMessage(
        (error as Error).message || "Не удалось выполнить симуляцию.",
      );
    } finally {
      setTestProactivityBusy(false);
    }
  }

  function handleAddDiaryFilterTag(tag: string) {
    const normalized = tag.trim();
    if (!normalized) return;
    setSelectedDiaryFilterTags((current) =>
      current.includes(normalized) ? current : [...current, normalized],
    );
    setDiaryFilterPickerValue("");
  }

  function handleRemoveDiaryFilterTag(tag: string) {
    setSelectedDiaryFilterTags((current) =>
      current.filter((value) => value !== tag),
    );
  }

  function handleDeleteSelectedDiaryEntry() {
    if (!chat?.id || !selectedDiaryEntry) return;
    const confirmed = window.confirm("Удалить эту запись дневника?");
    if (!confirmed) return;
    onDeleteDiaryEntry(chat.id, selectedDiaryEntry.id);
  }

  function renderDiaryEntryContent(
    entry: DiaryEntry,
    options: {
      createdLabel: string;
      removableTags: boolean;
      showTagEditor: boolean;
      showDeleteAction: boolean;
    },
  ) {
    return (
      <>
        <div className="diary-entry-head">
          <p>
            <strong>{options.createdLabel}:</strong>{" "}
            {formatDateTime(entry.createdAt)}
          </p>
          <p>
            <strong>Источник:</strong> {entry.sourceRange.messageCount} сообщ.
          </p>
          {options.showDeleteAction ? (
            <div className="diary-entry-head-actions">
              <button
                type="button"
                className="danger"
                onClick={handleDeleteSelectedDiaryEntry}
              >
                Удалить запись
              </button>
            </div>
          ) : null}
        </div>
        <div className="diary-entry-tags">
          {entry.tags.map((tag) =>
            options.removableTags ? (
              <button
                key={tag}
                type="button"
                className="diary-tag-chip"
                onClick={() => handleRemoveDiaryTag(tag)}
                title="Удалить тег"
              >
                {formatDiaryTagForDisplay(tag)} ×
              </button>
            ) : (
              <span key={tag} className="diary-tag-chip">
                {formatDiaryTagForDisplay(tag)}
              </span>
            ),
          )}
        </div>
        {options.showTagEditor ? (
          <div className="diary-tag-editor">
            <input
              type="text"
              value={diaryTagDraft}
              placeholder="topic:разговор о поездке"
              onChange={(event) => setDiaryTagDraft(event.target.value)}
            />
            <button
              type="button"
              className="secondary"
              onClick={handleAddDiaryTag}
              disabled={!normalizeDiaryTagInput(diaryTagDraft)}
            >
              Добавить тег
            </button>
          </div>
        ) : null}
        <div className="diary-markdown-renderer">
          {renderDiaryMarkdown(entry.markdown)}
        </div>
      </>
    );
  }

  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal large" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>Детали чата</h2>
            <p className="modal-subtitle">{chat?.title ?? "Новый чат"}</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Закрыть">
            <X size={18} />
          </button>
        </header>

        <div className="modal-tabs">
          <button
            type="button"
            className={tab === "attachments" ? "active" : ""}
            onClick={() => setTab("attachments")}
          >
            Вложения
          </button>
          <button
            type="button"
            className={tab === "status" ? "active" : ""}
            onClick={() => setTab("status")}
          >
            Статус
          </button>
          <button
            type="button"
            className={tab === "proactivity" ? "active" : ""}
            onClick={() => setTab("proactivity")}
          >
            Симуляция
          </button>
          <button
            type="button"
            className={tab === "diaries" ? "active" : ""}
            onClick={() => setTab("diaries")}
          >
            Дневники
          </button>
        </div>

        {tab === "attachments" ? (
          <section className="chat-details-body">
            {attachments.length === 0 ? (
              <p className="empty-state">В этом чате пока нет картинок.</p>
            ) : (
              <div className="attachment-grid">
                {attachments.map((attachment) => {
                  const resolvedSrc =
                    resolvedImageBySource[attachment.src] ??
                    (parseIdbAssetId(attachment.src) ? "" : attachment.src);
                  return (
                    <article key={`${attachment.messageId}-${attachment.src}`} className="attachment-card">
                      <button
                        type="button"
                        className="attachment-preview-btn"
                        onClick={() => {
                          setPreviewSrc(resolvedSrc || null);
                          setPreviewMeta(attachment.meta);
                          setPreviewAttachment(attachment);
                        }}
                      >
                        {resolvedSrc ? (
                          <img src={resolvedSrc} alt={attachment.alt} loading="lazy" />
                        ) : (
                          <div className="image-skeleton-card" />
                        )}
                      </button>
                      <div className="attachment-meta">
                        <span>{attachment.role === "assistant" ? "Ассистент" : "Пользователь"}</span>
                        <span>{formatDateTime(attachment.createdAt)}</span>
                      </div>
                      {resolvedSrc ? (
                        <a
                          href={resolvedSrc}
                          target="_blank"
                          rel="noreferrer"
                          className="attachment-link"
                        >
                          Открыть <ExternalLink size={14} />
                        </a>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : tab === "status" ? (
          <section className="chat-details-body status-tab">
            <div className="status-lock-toggle">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={stateLocked}
                  onChange={(event) => {
                    const nextLocked = event.target.checked;
                    setStateLocked(nextLocked);
                    if (nextLocked && runtimeState) {
                      setRuntimeDraft(toEditableRuntimeState(runtimeState));
                    }
                    if (nextLocked) {
                      setEditingMemoryId(null);
                      setMemoryEditDraft(null);
                      setEditingEvolutionProposalId(null);
                      setEvolutionEditReason("");
                      setEvolutionEditPatchText(DEFAULT_EVOLUTION_PATCH_TEMPLATE);
                      setEvolutionEditError(null);
                    }
                  }}
                />
                Блокировать состояние
              </label>
              <p className="status-lock-hint">
                Когда блокировка отключена, можно вручную менять runtime state, память и эволюцию.
              </p>
            </div>

            <div className="status-grid">
              <div className="status-card">
                <h4>Общее</h4>
                <p>Персона: {persona?.name ?? "—"}</p>
                <p>Сообщений: {messages.length}</p>
                <p>Картинок: {attachments.length}</p>
                <p>Создан: {formatDateTime(chat?.createdAt ?? "")}</p>
                <p>Обновлен: {formatDateTime(chat?.updatedAt ?? "")}</p>
              </div>

              <div className="status-card">
                <h4>Runtime state (кратко)</h4>
                {!runtimeState ? (
                  <p>Состояние пока не инициализировано.</p>
                ) : stateLocked || !runtimeDraft ? (
                  <>
                    <p>mood: {runtimeState.mood}</p>
                    <p>
                      relationship: {runtimeState.relationshipType} / {runtimeState.relationshipStage}
                    </p>
                    <p>trust: {runtimeState.trust}</p>
                    <p>engagement: {runtimeState.engagement}</p>
                    <p>energy: {runtimeState.energy}</p>
                    <p>relationshipDepth: {runtimeState.relationshipDepth}</p>
                    <p>updatedAt: {formatDateTime(runtimeState.updatedAt)}</p>
                  </>
                ) : (
                  <div className="runtime-edit-grid">
                    <label>
                      mood
                      <Dropdown
                        value={runtimeDraft.mood}
                        options={runtimeMoodDropdownOptions}
                        onChange={(value) => {
                          const nextMood = value as PersonaRuntimeState["mood"];
                          setRuntimeDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  mood: nextMood,
                                }
                              : current,
                          );
                        }}
                        searchable={false}
                      />
                    </label>
                    <label>
                      relationshipType
                      <Dropdown
                        value={runtimeDraft.relationshipType}
                        options={runtimeRelationshipTypeDropdownOptions}
                        onChange={(value) => {
                          const nextType = value as PersonaRuntimeState["relationshipType"];
                          setRuntimeDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  relationshipType: nextType,
                                }
                              : current,
                          );
                        }}
                        searchable={false}
                      />
                    </label>
                    <label>
                      trust
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.trust}
                        onChange={(event) => updateRuntimeMetric("trust", event.target.value)}
                      />
                    </label>
                    <label>
                      engagement
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.engagement}
                        onChange={(event) => updateRuntimeMetric("engagement", event.target.value)}
                      />
                    </label>
                    <label>
                      energy
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.energy}
                        onChange={(event) => updateRuntimeMetric("energy", event.target.value)}
                      />
                    </label>
                    <label>
                      lust
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.lust}
                        onChange={(event) => updateRuntimeMetric("lust", event.target.value)}
                      />
                    </label>
                    <label>
                      fear
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.fear}
                        onChange={(event) => updateRuntimeMetric("fear", event.target.value)}
                      />
                    </label>
                    <label>
                      affection
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.affection}
                        onChange={(event) => updateRuntimeMetric("affection", event.target.value)}
                      />
                    </label>
                    <label>
                      tension
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.tension}
                        onChange={(event) => updateRuntimeMetric("tension", event.target.value)}
                      />
                    </label>
                    <label>
                      relationshipDepth
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={runtimeDraft.relationshipDepth}
                        onChange={(event) =>
                          updateRuntimeMetric("relationshipDepth", event.target.value)
                        }
                      />
                    </label>
                    <div className="runtime-edit-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={!canSaveRuntimeDraft}
                        onClick={handleSaveRuntimeState}
                      >
                        Сохранить состояние
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="status-card">
                <h4>Chat Summary (кратко)</h4>
                <p className="status-caption">Что персона сейчас держит в голове.</p>
                <p className="status-block-text">{summaryPreview}</p>
                <p>updatedAt: {formatDateTime(chat?.summaryUpdatedAt ?? "")}</p>
                <p>tokenBudget: {Number.isFinite(chat?.summaryTokenBudget) ? chat?.summaryTokenBudget : "—"}</p>
                <p>
                  facts/goals/threads/agreements: {summaryFactsCount}/{summaryGoalsCount}/
                  {summaryOpenThreadsCount}/{summaryAgreementsCount}
                </p>
              </div>

              <div className="status-card">
                <h4>Флаги</h4>
                <p>
                  Показывать системный блок изображения:{" "}
                  {settings.showSystemImageBlock ? "да" : "нет"}
                </p>
                <p>Показывать изменения статуса: {settings.showStatusChangeDetails ? "да" : "нет"}</p>
              </div>

              <div className="status-card">
                <h4>Style reference</h4>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={useGlobalStyleStrength}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setUseGlobalStyleStrength(next);
                      if (chat) {
                        onUpdateChatStyleStrength(
                          chat.id,
                          next ? null : chatStyleStrengthDraft,
                        );
                      }
                    }}
                  />
                  Использовать глобальную силу style reference
                </label>
                <label>
                  Сила style reference для этого чата
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={chatStyleStrengthDraft}
                    disabled={useGlobalStyleStrength}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      const next = Number.isFinite(parsed)
                        ? Math.max(0, Math.min(1, parsed))
                        : chatStyleStrengthDraft;
                      setChatStyleStrengthDraft(next);
                      if (!useGlobalStyleStrength && chat) {
                        onUpdateChatStyleStrength(chat.id, next);
                      }
                    }}
                  />
                  <small style={{ color: "var(--text-secondary)", display: "block", marginTop: 6 }}>
                    Приоритет выше глобальной настройки. Если включено наследование, используется значение из настроек.
                  </small>
                </label>
              </div>

              <div className="status-card">
                <h4>Уведомления</h4>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={notificationsEnabled}
                    disabled={!isAndroidRuntime}
                    onChange={(event) => {
                      if (!chat?.id || !isAndroidRuntime) return;
                      onToggleNotificationsEnabled(chat.id, event.target.checked);
                    }}
                  />
                  Уведомления для этого чата
                </label>
                <p className="status-lock-hint">
                  Пуши приходят только в фоне и только для входящих сообщений
                  персонажа.
                </p>
                {!isAndroidRuntime ? (
                  <p className="status-lock-hint">Android-only (на этой платформе только просмотр).</p>
                ) : null}
              </div>

              <div className="status-card">
                <h4>Проактивность</h4>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={proactivityEnabled}
                    disabled={!isAndroidRuntime}
                    onChange={(event) => {
                      if (!chat?.id || !isAndroidRuntime) return;
                      onToggleProactivityEnabled(chat.id, event.target.checked);
                    }}
                  />
                  Включить проактивность в этом чате
                </label>
                <p className="status-lock-hint">
                  Работает только в Android и только для 1:1 чатов.
                </p>
                {!isAndroidRuntime ? (
                  <p className="status-lock-hint">Android-only (на этой платформе только просмотр).</p>
                ) : null}
                <p className="status-lock-hint">
                  Dry-run симуляция вынесена во вкладку «Симуляция».
                </p>
              </div>

              <div className="status-card">
                <h4>Эволюция</h4>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={evolutionEnabled}
                    onChange={(event) => {
                      if (!chat?.id) return;
                      onToggleEvolutionEnabled(chat.id, event.target.checked);
                    }}
                  />
                  Включить эволюцию в этом чате
                </label>
                <label>
                  Режим применения
                  <Dropdown
                    value={evolutionApplyMode}
                    options={evolutionApplyModeDropdownOptions}
                    onChange={(value) => {
                      if (!chat?.id) return;
                      onChangeEvolutionApplyMode(
                        chat.id,
                        value === "auto" ? "auto" : "manual",
                      );
                    }}
                    searchable={false}
                  />
                </label>
                <p>pending: {evolutionPending.length}</p>
                <p>applied: {appliedEvolutionHistory.length}</p>
                <button
                  type="button"
                  className="secondary"
                  disabled={!canUndoEvolution}
                  onClick={() => {
                    if (!chat?.id) return;
                    onUndoLastAppliedEvolution(chat.id);
                  }}
                >
                  Undo last applied
                </button>
              </div>
            </div>

            <div className="status-accordion-list">
              <details className="status-accordion">
                <summary>Runtime state (детально)</summary>
                <div className="status-accordion-body">
                  {runtimeState ? (
                    <>
                      <p>mood: {runtimeState.mood}</p>
                      <p>trust: {runtimeState.trust}</p>
                      <p>engagement: {runtimeState.engagement}</p>
                      <p>energy: {runtimeState.energy}</p>
                      <p>lust: {runtimeState.lust}</p>
                      <p>fear: {runtimeState.fear}</p>
                      <p>affection: {runtimeState.affection}</p>
                      <p>tension: {runtimeState.tension}</p>
                      <p>relationshipType: {runtimeState.relationshipType}</p>
                      <p>relationshipDepth: {runtimeState.relationshipDepth}</p>
                      <p>relationshipStage: {runtimeState.relationshipStage}</p>
                      <p>updatedAt: {formatDateTime(runtimeState.updatedAt)}</p>
                    </>
                  ) : (
                    <p>Состояние пока не инициализировано.</p>
                  )}
                </div>
              </details>

              <details className="status-accordion">
                <summary>Chat Summary (что персона видит в голове)</summary>
                <div className="status-accordion-body">
                  <p className="status-block-text">{chat?.conversationSummary?.trim() || "—"}</p>
                  <p>updatedAt: {formatDateTime(chat?.summaryUpdatedAt ?? "")}</p>
                  <p>tokenBudget: {Number.isFinite(chat?.summaryTokenBudget) ? chat?.summaryTokenBudget : "—"}</p>
                  <p>cursorMessageId: {chat?.summaryCursorMessageId?.trim() || "—"}</p>

                  <div className="status-subsection">
                    <p className="status-subtitle">facts</p>
                    {chat?.summaryFacts && chat.summaryFacts.length > 0 ? (
                      <ul className="status-list">
                        {chat.summaryFacts.map((fact, index) => (
                          <li key={`summary-fact-${index}`}>{fact}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>—</p>
                    )}
                  </div>

                  <div className="status-subsection">
                    <p className="status-subtitle">goals</p>
                    {chat?.summaryGoals && chat.summaryGoals.length > 0 ? (
                      <ul className="status-list">
                        {chat.summaryGoals.map((goal, index) => (
                          <li key={`summary-goal-${index}`}>{goal}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>—</p>
                    )}
                  </div>

                  <div className="status-subsection">
                    <p className="status-subtitle">openThreads</p>
                    {chat?.summaryOpenThreads && chat.summaryOpenThreads.length > 0 ? (
                      <ul className="status-list">
                        {chat.summaryOpenThreads.map((thread, index) => (
                          <li key={`summary-thread-${index}`}>{thread}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>—</p>
                    )}
                  </div>

                  <div className="status-subsection">
                    <p className="status-subtitle">agreements</p>
                    {chat?.summaryAgreements && chat.summaryAgreements.length > 0 ? (
                      <ul className="status-list">
                        {chat.summaryAgreements.map((agreement, index) => (
                          <li key={`summary-agreement-${index}`}>{agreement}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>—</p>
                    )}
                  </div>
                </div>
              </details>

              <details className="status-accordion">
                <summary>Последние сигналы и control</summary>
                <div className="status-accordion-body">
                  <p>lastUserInputAt: {formatDateTime(lastUserMessage?.createdAt ?? "")}</p>
                  <p className="status-block-text">{lastUserPreview}</p>
                  <p>lastPersonaReplyAt: {formatDateTime(lastAssistantMessage?.createdAt ?? "")}</p>
                  <p className="status-block-text">{lastAssistantPreview}</p>
                  <p>lastControlAt: {formatDateTime(lastControl?.message.createdAt ?? "")}</p>
                  <p>intents: {lastControl?.control.intents?.join(", ") || "—"}</p>
                  <p>state_delta: {formatStateDelta(lastControl?.control.state_delta)}</p>
                  <p>
                    memory_add: {lastControl?.control.memory_add?.length ?? 0} | memory_remove:{" "}
                    {lastControl?.control.memory_remove?.length ?? 0}
                  </p>
                  <p>
                    relationshipProposal:{" "}
                    {lastRelationshipProposalMessage
                      ? [
                          lastRelationshipProposalMessage.relationshipProposalType
                            ? `type=${lastRelationshipProposalMessage.relationshipProposalType}`
                            : "",
                          lastRelationshipProposalMessage.relationshipProposalStage
                            ? `stage=${lastRelationshipProposalMessage.relationshipProposalStage}`
                            : "",
                          lastRelationshipProposalMessage.relationshipProposalStatus
                            ? `status=${lastRelationshipProposalMessage.relationshipProposalStatus}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(", ") || "есть, но без деталей"
                      : "—"}
                  </p>
                </div>
              </details>

              <details className="status-accordion">
                <summary>
                  Эволюция • pending {evolutionPending.length} • history{" "}
                  {evolutionHistory.length}
                </summary>
                <div className="status-accordion-body">
                  <div className="status-subsection">
                    <p className="status-subtitle">Pending proposals</p>
                    <div className="manual-memory-form">
                      <h5>Добавить proposal эволюции вручную</h5>
                      {stateLocked ? (
                        <p className="status-lock-hint">
                          Разблокируйте состояние, чтобы создавать или редактировать эволюцию.
                        </p>
                      ) : null}
                      <label>
                        reason
                        <input
                          type="text"
                          value={manualEvolutionReason}
                          disabled={stateLocked}
                          placeholder="Почему нужна эволюция на этом шаге"
                          onChange={(event) => {
                            setManualEvolutionReason(event.target.value);
                            if (manualEvolutionError) setManualEvolutionError(null);
                          }}
                        />
                      </label>
                      <label>
                        patch (JSON)
                        <textarea
                          className="memory-textarea"
                          rows={8}
                          value={manualEvolutionPatchText}
                          disabled={stateLocked}
                          onChange={(event) => {
                            setManualEvolutionPatchText(event.target.value);
                            if (manualEvolutionError) setManualEvolutionError(null);
                          }}
                        />
                      </label>
                      {manualEvolutionError ? (
                        <p className="status-lock-hint">{manualEvolutionError}</p>
                      ) : null}
                      <button
                        type="button"
                        className="primary"
                        disabled={!canAddManualEvolutionProposal}
                        onClick={handleAddPendingEvolutionProposal}
                      >
                        Добавить proposal
                      </button>
                    </div>
                    {pendingEvolutionPresentation.length === 0 ? (
                      <p>—</p>
                    ) : (
                      <div className="memory-list">
                        {pendingEvolutionPresentation.map(({ proposal, deltaRows }) => (
                          <article key={proposal.id} className="memory-item">
                            {editingEvolutionProposalId === proposal.id && !stateLocked ? (
                              <>
                                <div className="memory-head">
                                  <strong>{formatDateTime(proposal.createdAt)}</strong>
                                  <span>{formatEvolutionPatchSummary(proposal.patch)}</span>
                                </div>
                                <label>
                                  reason
                                  <input
                                    type="text"
                                    value={evolutionEditReason}
                                    onChange={(event) => {
                                      setEvolutionEditReason(event.target.value);
                                      if (evolutionEditError) setEvolutionEditError(null);
                                    }}
                                  />
                                </label>
                                <label>
                                  patch (JSON)
                                  <textarea
                                    className="memory-textarea"
                                    rows={8}
                                    value={evolutionEditPatchText}
                                    onChange={(event) => {
                                      setEvolutionEditPatchText(event.target.value);
                                      if (evolutionEditError) setEvolutionEditError(null);
                                    }}
                                  />
                                </label>
                                {evolutionEditError ? (
                                  <p className="status-lock-hint">{evolutionEditError}</p>
                                ) : null}
                                <div className="memory-actions">
                                  <button
                                    type="button"
                                    className="primary"
                                    disabled={!canSaveEvolutionEdit}
                                    onClick={handleSavePendingEvolutionEdit}
                                  >
                                    Сохранить
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary"
                                    onClick={handleCancelPendingEvolutionEdit}
                                  >
                                    Отмена
                                  </button>
                                  <button
                                    type="button"
                                    className="danger"
                                    onClick={() => handleDeletePendingEvolutionProposal(proposal.id)}
                                  >
                                    Удалить
                                  </button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="memory-head">
                                  <strong>{formatDateTime(proposal.createdAt)}</strong>
                                  <span>{formatEvolutionPatchSummary(proposal.patch)}</span>
                                </div>
                                <p>{proposal.reason || "Без причины"}</p>
                                <p className="status-caption">
                                  Δ было -&gt; стало ({evolutionSnapshotLabel})
                                </p>
                                {deltaRows.length > 0 ? (
                                  <ul className="status-list evolution-delta-list">
                                    {deltaRows.map((row) => (
                                      <li key={`${proposal.id}-delta-${row.field}`}>
                                        <span title={row.field}>
                                          {formatPersonaEvolutionFieldLabel(row.field)}
                                        </span>
                                        : {row.before} -&gt; {row.after}
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="status-caption">Дельта: —</p>
                                )}
                                <div className="memory-actions">
                                  <button
                                    type="button"
                                    className="primary"
                                    onClick={() => {
                                      if (!chat?.id) return;
                                      onApprovePendingEvolution(chat.id, proposal.id);
                                    }}
                                  >
                                    Принять
                                  </button>
                                  <button
                                    type="button"
                                    className="danger"
                                    onClick={() => {
                                      if (!chat?.id) return;
                                      onRejectPendingEvolution(chat.id, proposal.id);
                                    }}
                                  >
                                    Отклонить
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary"
                                    disabled={stateLocked}
                                    onClick={() => startPendingEvolutionEdit(proposal)}
                                  >
                                    Редактировать
                                  </button>
                                  <button
                                    type="button"
                                    className="danger"
                                    disabled={stateLocked}
                                    onClick={() => handleDeletePendingEvolutionProposal(proposal.id)}
                                  >
                                    Удалить
                                  </button>
                                </div>
                              </>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="status-subsection">
                    <p className="status-subtitle">History</p>
                    {evolutionHistoryPresentation.length === 0 ? (
                      <p>—</p>
                    ) : (
                      <div className="memory-list">
                        {[...evolutionHistoryPresentation]
                          .slice()
                          .reverse()
                          .map(({ event, deltaRows, deltaMode }) => (
                            <article key={event.id} className="memory-item">
                              <div className="memory-head">
                                <strong>{event.status}</strong>
                                <span>{formatDateTime(event.timestamp)}</span>
                              </div>
                              <p>{event.reason || "Без причины"}</p>
                              <time>{formatEvolutionPatchSummary(event.patch)}</time>
                              <p className="status-caption">
                                {deltaMode === "applied"
                                  ? "Δ было -> стало (applied)"
                                  : deltaMode === "undo"
                                    ? "Δ было -> стало (undo)"
                                    : "Δ было -> стало (proposal)"}
                              </p>
                              {deltaRows.length > 0 ? (
                                <ul className="status-list evolution-delta-list">
                                  {deltaRows.map((row) => (
                                    <li key={`${event.id}-delta-${row.field}`}>
                                      <span title={row.field}>
                                        {formatPersonaEvolutionFieldLabel(row.field)}
                                      </span>
                                      : {row.before} -&gt; {row.after}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="status-caption">Дельта: —</p>
                              )}
                            </article>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              </details>

              <details className="status-accordion">
                <summary>
                  Память ({memories.length}) • short {memoryByLayer.shortTerm.length} • episodic{" "}
                  {memoryByLayer.episodic.length} • long {memoryByLayer.longTerm.length}
                </summary>
                <div className="status-accordion-body">
                  <div className="manual-memory-form">
                    <h5>Добавить запись в память вручную</h5>
                    {stateLocked ? (
                      <p className="status-lock-hint">
                        Разблокируйте состояние, чтобы добавлять, редактировать или удалять память.
                      </p>
                    ) : null}
                    <div className="manual-memory-grid">
                      <label>
                        layer
                        <Dropdown
                          value={manualMemoryLayer}
                          options={memoryLayerDropdownOptions}
                          onChange={(value) => setManualMemoryLayer(value as PersonaMemory["layer"])}
                          disabled={stateLocked}
                          searchable={false}
                        />
                      </label>
                      <label>
                        kind
                        <Dropdown
                          value={manualMemoryKind}
                          options={memoryKindDropdownOptions}
                          onChange={(value) => setManualMemoryKind(value as PersonaMemory["kind"])}
                          disabled={stateLocked}
                          searchable={false}
                        />
                      </label>
                      <label>
                        salience
                        <input
                          type="number"
                          min={0.1}
                          max={1}
                          step={0.01}
                          value={manualMemorySalience}
                          disabled={stateLocked}
                          onChange={(event) => {
                            const parsed = Number(event.target.value);
                            if (!Number.isFinite(parsed)) return;
                            setManualMemorySalience(Math.max(0.1, Math.min(1, parsed)));
                          }}
                        />
                      </label>
                    </div>
                    <label>
                      content
                      <textarea
                        className="memory-textarea"
                        rows={3}
                        value={manualMemoryContent}
                        placeholder="Например: [fact] Пользователь любит длинные прогулки вечером."
                        disabled={stateLocked}
                        onChange={(event) => setManualMemoryContent(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="primary"
                      disabled={!canAddManualMemory}
                      onClick={handleAddManualMemory}
                    >
                      Добавить в память
                    </button>
                  </div>

                  {memories.length === 0 ? (
                    <p className="empty-state">Память по этому чату пока пустая.</p>
                  ) : (
                    <div className="memory-list">
                      {memories.map((memory) => (
                        <article key={memory.id} className="memory-item">
                          {editingMemoryId === memory.id && memoryEditDraft && !stateLocked ? (
                            <>
                              <div className="memory-edit-grid">
                                <label>
                                  layer
                                  <Dropdown
                                    value={memoryEditDraft.layer}
                                    options={memoryLayerDropdownOptions}
                                    disabled={stateLocked}
                                    onChange={(value) =>
                                      setMemoryEditDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              layer: value as PersonaMemory["layer"],
                                            }
                                          : current,
                                      )
                                    }
                                    searchable={false}
                                  />
                                </label>
                                <label>
                                  kind
                                  <Dropdown
                                    value={memoryEditDraft.kind}
                                    options={memoryKindDropdownOptions}
                                    disabled={stateLocked}
                                    onChange={(value) =>
                                      setMemoryEditDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              kind: value as PersonaMemory["kind"],
                                            }
                                          : current,
                                      )
                                    }
                                    searchable={false}
                                  />
                                </label>
                                <label>
                                  salience
                                  <input
                                    type="number"
                                    min={0.1}
                                    max={1}
                                    step={0.01}
                                    value={memoryEditDraft.salience}
                                    disabled={stateLocked}
                                    onChange={(event) => {
                                      const parsed = Number(event.target.value);
                                      if (!Number.isFinite(parsed)) return;
                                      setMemoryEditDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              salience: Math.max(0.1, Math.min(1, parsed)),
                                            }
                                          : current,
                                      );
                                    }}
                                  />
                                </label>
                                <label className="memory-edit-content">
                                  content
                                  <textarea
                                    className="memory-textarea"
                                    rows={3}
                                    value={memoryEditDraft.content}
                                    disabled={stateLocked}
                                    onChange={(event) =>
                                      setMemoryEditDraft((current) =>
                                        current
                                          ? {
                                              ...current,
                                              content: event.target.value,
                                            }
                                          : current,
                                      )
                                    }
                                  />
                                </label>
                              </div>
                              <div className="memory-actions">
                                <button
                                  type="button"
                                  className="primary"
                                  disabled={!canSaveMemoryEdit}
                                  onClick={handleSaveMemoryEdit}
                                >
                                  Сохранить
                                </button>
                                <button type="button" onClick={handleCancelMemoryEdit}>
                                  Отмена
                                </button>
                                <button
                                  type="button"
                                  className="danger"
                                  disabled={stateLocked}
                                  onClick={() => handleDeleteMemory(memory.id)}
                                >
                                  Удалить
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="memory-head">
                                <strong>
                                  {memory.layer} / {memory.kind}
                                </strong>
                                <span>salience: {memory.salience.toFixed(2)}</span>
                              </div>
                              <p>{memory.content}</p>
                              <time>{formatDateTime(memory.updatedAt)}</time>
                              <div className="memory-actions">
                                <button
                                  type="button"
                                  disabled={stateLocked}
                                  onClick={() => startMemoryEdit(memory)}
                                >
                                  Редактировать
                                </button>
                                <button
                                  type="button"
                                  className="danger"
                                  disabled={stateLocked}
                                  onClick={() => handleDeleteMemory(memory.id)}
                                >
                                  Удалить
                                </button>
                              </div>
                            </>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            </div>
          </section>
        ) : tab === "proactivity" ? (
          <section className="chat-details-body diaries-tab">
            <div className="diary-toggle-card">
              <h4 style={{ marginTop: 0, marginBottom: 8 }}>Симуляция проактивности</h4>
              <p className="status-lock-hint">
                Dry-run: выполняет полный proactive-flow и показывает все этапы без
                сохранений, сообщений и изменений состояния.
              </p>
              {!isAndroidRuntime ? (
                <p className="status-lock-hint">Android-only (на этой платформе только просмотр).</p>
              ) : null}
              <div className="diary-test-actions proactivity-sim-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void handleTestProactivitySimulation();
                  }}
                  disabled={!chat?.id || testProactivityBusy || !isAndroidRuntime}
                >
                  {testProactivityBusy
                    ? "Симуляция..."
                    : "Симуляция проактивности"}
                </button>
              </div>
              {testProactivityMessage ? (
                <p className="status-lock-hint">{testProactivityMessage}</p>
              ) : null}
            </div>

            {testProactivityReport ? (
              <div className="proactivity-simulation-report">
                <p>
                  simulatedAt:{" "}
                  {formatDateTime(testProactivityReport.simulatedAt)}
                </p>
                <p>
                  personaId: {testProactivityReport.personaId || "—"}
                </p>
                {testProactivityReport.summary ? (
                  <pre className="proactivity-simulation-json">
                    {JSON.stringify(testProactivityReport.summary, null, 2)}
                  </pre>
                ) : null}
                <div className="proactivity-simulation-stages">
                  {testProactivityReport.stages.map((stage, index) => (
                    <article
                      key={`${stage.id}-${index}`}
                      className="proactivity-simulation-stage"
                    >
                      <div className="proactivity-simulation-stage-head">
                        <strong>
                          {index + 1}. {stage.title}
                        </strong>
                        <span
                          className={`proactivity-simulation-badge ${stage.status}`}
                        >
                          {formatSimulationStageStatusLabel(stage.status)}
                        </span>
                      </div>
                      <p className="status-lock-hint">{stage.id}</p>
                      {stage.details ? (
                        <pre className="proactivity-simulation-json">
                          {JSON.stringify(stage.details, null, 2)}
                        </pre>
                      ) : null}
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="chat-details-body diaries-tab">
            <div className="diary-toggle-card">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={diaryEnabled}
                  onChange={(event) => {
                    if (!chat?.id) return;
                    onToggleDiaryEnabled(chat.id, event.target.checked);
                  }}
                />
                Вести дневник в этом чате
              </label>
              <p className="status-lock-hint">
                Автоматические записи создаются только при неактивности чата и
                наличии содержательных новых сообщений.
              </p>
            </div>
            <div className="diary-toggle-card">
              <div className="diary-test-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void handleTestDiaryGeneration();
                  }}
                  disabled={!chat?.id || testDiaryBusy}
                >
                  {testDiaryBusy ? "Генерация..." : "Тест генерации"}
                </button>
                <span className="status-lock-hint">
                  Запускает полный флоу генерации без сохранения в базу.
                </span>
              </div>
              {testDiaryMessage ? <p className="status-lock-hint">{testDiaryMessage}</p> : null}
            </div>

            {!diaryEnabled ? (
              <p className="status-lock-hint">
                Автогенерация сейчас выключена, но существующие записи дневника
                остаются доступными.
              </p>
            ) : null}

            {testDiaryEntries.length > 0 ? (
              <div>
                {testDiaryEntries.map((entry, index) => (
                  <article key={entry.id} className="diary-entry-view">
                    {renderDiaryEntryContent(entry, {
                      createdLabel: `Тестовый результат #${index + 1}`,
                      removableTags: false,
                      showTagEditor: false,
                      showDeleteAction: false,
                    })}
                  </article>
                ))}
              </div>
            ) : null}

            {diaryEntries.length === 0 ? (
              <p className="empty-state">
                {diaryEnabled
                  ? "Записей пока нет. Персона добавит первую запись, когда появится подходящий момент."
                  : "Записей пока нет. Включите автогенерацию, чтобы персона могла вести дневник."}
              </p>
            ) : (
              <div className="diary-filter-card">
                <div className="diary-filter-card-head">
                  <strong>Фильтр по тегам</strong>
                  {selectedDiaryFilterTags.length > 0 ? (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setSelectedDiaryFilterTags([])}
                    >
                      Сбросить
                    </button>
                  ) : null}
                </div>
                <div className="diary-filter-picker">
                  <Dropdown
                    value={diaryFilterPickerValue}
                    options={
                      diaryFilterPickerOptions.length > 0
                        ? diaryFilterPickerOptions
                        : [{ value: "", label: "Все теги уже выбраны" }]
                    }
                    onChange={(nextTag) => {
                      setDiaryFilterPickerValue(nextTag);
                      if (nextTag) handleAddDiaryFilterTag(nextTag);
                    }}
                    placeholder="Выберите тег"
                    disabled={diaryFilterPickerOptions.length === 0}
                    portal
                    searchable
                    searchMinOptions={0}
                    searchPlaceholder="Поиск тега..."
                  />
                </div>
                <div className="diary-filter-chip-list" aria-label="Выбранные теги фильтра">
                  {selectedDiaryFilterTags.map((tag) => (
                    <span key={tag} className="diary-filter-chip">
                      <span className="diary-filter-chip-meta">
                        <strong>{formatDiaryTagForDisplay(tag)}</strong>
                      </span>
                      <button
                        type="button"
                        className="icon-btn mini"
                        onClick={() => handleRemoveDiaryFilterTag(tag)}
                        title="Удалить тег из фильтра"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  {selectedDiaryFilterTags.length === 0 ? (
                    <small style={{ color: "var(--text-secondary)" }}>
                      Выберите один или несколько тегов в списке выше.
                    </small>
                  ) : null}
                </div>
              </div>
            )}

            {diaryEntries.length > 0 ? (
              <div className={`diary-layout ${isMobileDiaryViewport ? "mobile" : ""}`}>
                <aside className="diary-list">
                  {groupedDiaryEntries.length === 0 ? (
                    <p className="empty-state">По выбранным тегам ничего не найдено.</p>
                  ) : (
                    groupedDiaryEntries.map((group) => (
                      <section key={group.dateKey} className="diary-date-group">
                        <p className="diary-date-group-title">{group.label}</p>
                        {group.entries.map((entry) => (
                          <button
                            key={entry.id}
                            type="button"
                            className={`diary-list-item ${
                              selectedDiaryEntry?.id === entry.id ? "active" : ""
                            }`}
                            onClick={() => {
                              setSelectedDiaryEntryId(entry.id);
                              if (isMobileDiaryViewport) setMobileDiaryDetailOpen(true);
                            }}
                          >
                            <strong>{formatTime(entry.createdAt)}</strong>
                            <span>
                              {entry.tags
                                .slice(0, 3)
                                .map((tag) => formatDiaryTagForDisplay(tag))
                                .join(" • ") || "Без тегов"}
                            </span>
                          </button>
                        ))}
                      </section>
                    ))
                  )}
                </aside>

                <article
                  className={`diary-entry-view diary-entry-panel ${
                    !isMobileDiaryViewport || mobileDiaryDetailOpen ? "open" : ""
                  }`}
                >
                  {isMobileDiaryViewport ? (
                    <div className="diary-mobile-panel-head">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setMobileDiaryDetailOpen(false)}
                      >
                        Назад
                      </button>
                    </div>
                  ) : null}
                  {selectedDiaryEntry ? (
                    renderDiaryEntryContent(selectedDiaryEntry, {
                      createdLabel: "Создано",
                      removableTags: true,
                      showTagEditor: true,
                      showDeleteAction: true,
                    })
                  ) : (
                    <p className="empty-state">Выберите запись слева.</p>
                  )}
                </article>
              </div>
            ) : null}
          </section>
        )}
      </div>
      <ImagePreviewModal
        src={previewSrc}
        meta={previewResolvedMeta}
        enhancePromptDefaults={previewEnhancePromptDefaults}
        actionBusy={imageActionBusy}
        onEnhance={
          previewAttachment
            ? (targetOverride, promptOverride) => {
                const effectivePromptOverride =
                  promptOverride ?? previewEnhancePromptDefaults;
                onEnhanceImage({
                  messageId: previewAttachment.messageId,
                  sourceUrl: previewAttachment.src,
                  meta: previewResolvedMeta,
                }, targetOverride, effectivePromptOverride);
              }
            : undefined
        }
        onRegenerate={
          previewAttachment
            ? (promptOverride) => {
                onRegenerateImage(
                  {
                    messageId: previewAttachment.messageId,
                    sourceUrl: previewAttachment.src,
                    meta: previewResolvedMeta,
                  },
                  promptOverride,
                );
              }
            : undefined
        }
        onClose={() => {
          setPreviewSrc(null);
          setPreviewMeta(undefined);
          setPreviewAttachment(null);
        }}
      />
    </div>
  );
}

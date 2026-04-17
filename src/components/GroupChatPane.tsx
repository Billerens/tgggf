import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Image,
  Pause,
  Play,
  RefreshCcw,
  ScrollText,
  SendHorizontal,
  StepForward,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { dbApi } from "../db";
import { splitAssistantContent } from "../messageContent";
import type { PersonaControlPayload } from "../personaDynamics";
import {
  resolvePersonaAvatarImageId,
  resolvePersonaExternalAvatarUrl,
} from "../personaAvatar";
import { formatShortTime } from "../ui/format";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { PersonaProfileModal } from "./PersonaProfileModal";
import { useSmartMessageAutoscroll } from "../ui/useSmartMessageAutoscroll";
import type {
  GroupMessage,
  GroupMessageMention,
  GroupParticipant,
  GroupRoom,
  GroupEvent,
  ImageGenerationMeta,
  Persona,
} from "../types";

interface GroupChatPaneProps {
  activeRoom: GroupRoom | null;
  participants: GroupParticipant[];
  messages: GroupMessage[];
  events: GroupEvent[];
  personas: Persona[];
  inputValue: string;
  setInputValue: (value: string) => void;
  isLoading: boolean;
  controlsDisabled: boolean;
  showSystemImageBlock: boolean;
  showStatusChangeDetails: boolean;
  onStartRoom: () => void;
  onPauseRoom: () => void;
  onRunIteration: () => void;
  onDeleteRoom: () => void;
  onSubmitMessage: (event: FormEvent) => void;
  onRetryMessageImages: (
    messageId: string,
    blockIndexes?: number[],
  ) => Promise<void> | void;
  onRegenerateMessageResponse: (messageId: string) => Promise<void> | void;
  onOpenChatDetails: () => void;
}

function renderMessageWithMentions(
  content: string,
  mentions: GroupMessageMention[] | undefined,
  classifyMention?: (label: string) => GroupMessageMention["targetType"] | null,
) {
  const fromProvided =
    mentions && mentions.length > 0
      ? mentions
      : (() => {
          if (!classifyMention) return [];
          const parsed: GroupMessageMention[] = [];
          const rx = /@([^\s@.,!?;:]+)/g;
          let match: RegExpExecArray | null;
          while ((match = rx.exec(content))) {
            const rawLabel = match[1]?.trim() ?? "";
            if (!rawLabel) continue;
            const targetType = classifyMention(rawLabel);
            if (!targetType) continue;
            parsed.push({
              targetType,
              targetId: "",
              label: rawLabel,
              start: match.index,
              end: match.index + match[0].length,
            });
          }
          return parsed;
        })();
  if (fromProvided.length === 0) return content;

  const sortedMentions = [...fromProvided]
    .filter(
      (mention) =>
        mention.start >= 0 &&
        mention.end > mention.start &&
        mention.end <= content.length,
    )
    .sort((a, b) => a.start - b.start);

  if (sortedMentions.length === 0) return content;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let mentionIndex = 0;

  for (const mention of sortedMentions) {
    if (mention.start < cursor) continue;
    if (mention.start > cursor) {
      nodes.push(content.slice(cursor, mention.start));
    }
    const text = content.slice(mention.start, mention.end);
    nodes.push(
      <span
        key={`mention-${mentionIndex}`}
        className={`group-mention ${mention.targetType}`}
        title={`Упоминание: ${mention.label}`}
      >
        {text}
      </span>,
    );
    cursor = mention.end;
    mentionIndex += 1;
  }

  if (cursor < content.length) {
    nodes.push(content.slice(cursor));
  }

  return nodes;
}

function formatEventPayload(payload: Record<string, unknown>) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "{}";
  }
}

function parsePersonaControlRaw(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PersonaControlPayload;
  } catch {
    return undefined;
  }
}

function formatDelta(label: string, value: number | undefined) {
  if (!Number.isFinite(value)) return null;
  const sign = value && value > 0 ? "+" : "";
  return `${label}: ${sign}${value}`;
}

function compactText(value: string | undefined, max = 140) {
  if (!value) return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function normalizeMentionToken(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, "");
}

function buildRussianMentionForms(token: string) {
  const normalized = normalizeMentionToken(token);
  if (!normalized) return [] as string[];

  const forms = new Set<string>([normalized]);
  if (normalized.endsWith("ия") && normalized.length > 3) {
    const stem = normalized.slice(0, -2);
    ["ия", "ии", "ию", "ией", "ие"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }
  if (normalized.endsWith("а") && normalized.length > 2) {
    const stem = normalized.slice(0, -1);
    ["а", "ы", "е", "у", "ой", "ою"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }
  if (normalized.endsWith("я") && normalized.length > 2) {
    const stem = normalized.slice(0, -1);
    ["я", "и", "е", "ю", "ей", "ею"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }
  if (normalized.endsWith("й") && normalized.length > 2) {
    const stem = normalized.slice(0, -1);
    ["й", "я", "ю", "ем", "е"].forEach((ending) =>
      forms.add(`${stem}${ending}`),
    );
    return Array.from(forms);
  }
  if (/[бвгджзклмнпрстфхцчшщ]$/u.test(normalized)) {
    ["а", "у", "ом", "е"].forEach((ending) =>
      forms.add(`${normalized}${ending}`),
    );
  }
  return Array.from(forms);
}

function buildStatusDetails(control: PersonaControlPayload | undefined) {
  if (!control) return "";

  const lines: string[] = [];
  const stateDelta = control.state_delta;

  if (control.intents && control.intents.length > 0) {
    lines.push(`intents: ${control.intents.join(", ")}`);
  }

  if (stateDelta) {
    const trust = formatDelta("trust", stateDelta.trust);
    const engagement = formatDelta("engagement", stateDelta.engagement);
    const energy = formatDelta("energy", stateDelta.energy);
    const lust = formatDelta("lust", stateDelta.lust);
    const fear = formatDelta("fear", stateDelta.fear);
    const affection = formatDelta("affection", stateDelta.affection);
    const tension = formatDelta("tension", stateDelta.tension);
    if (trust) lines.push(trust);
    if (engagement) lines.push(engagement);
    if (energy) lines.push(energy);
    if (lust) lines.push(lust);
    if (fear) lines.push(fear);
    if (affection) lines.push(affection);
    if (tension) lines.push(tension);
    if (stateDelta.mood) lines.push(`mood: ${stateDelta.mood}`);
    if (stateDelta.relationshipType)
      lines.push(`relationshipType: ${stateDelta.relationshipType}`);
    if (Number.isFinite(stateDelta.relationshipDepth)) {
      const sign =
        stateDelta.relationshipDepth && stateDelta.relationshipDepth > 0
          ? "+"
          : "";
      lines.push(`relationshipDepth: ${sign}${stateDelta.relationshipDepth}`);
    }
    if (stateDelta.relationshipStage)
      lines.push(`relationshipStage: ${stateDelta.relationshipStage}`);
  }

  if (control.memory_add && control.memory_add.length > 0) {
    lines.push("memory_add:");
    for (const memory of control.memory_add.slice(0, 6)) {
      const kind = memory.kind ?? "fact";
      const layer = memory.layer ?? "long_term";
      const content = compactText(memory.content, 160) || "(без контента)";
      lines.push(`+ [${kind}/${layer}] ${content}`);
    }
    if (control.memory_add.length > 6) {
      lines.push(`+ ... ещё ${control.memory_add.length - 6}`);
    }
  }

  if (control.memory_remove && control.memory_remove.length > 0) {
    lines.push("memory_remove:");
    for (const memory of control.memory_remove.slice(0, 6)) {
      const byId = memory.id ? `id=${memory.id}` : "";
      const kind = memory.kind ? `kind=${memory.kind}` : "";
      const layer = memory.layer ? `layer=${memory.layer}` : "";
      const content = memory.content
        ? `content="${compactText(memory.content, 100)}"`
        : "";
      const parts = [byId, kind, layer, content].filter(Boolean);
      lines.push(`- ${parts.join(", ") || "(не указан критерий удаления)"}`);
    }
    if (control.memory_remove.length > 6) {
      lines.push(`- ... ещё ${control.memory_remove.length - 6}`);
    }
  }

  return lines.join("\n");
}

interface RelationDelta {
  fromPersonaId: string;
  toPersonaId: string;
  trustFrom: number;
  trustTo: number;
  affinityFrom: number;
  affinityTo: number;
  tensionFrom: number;
  tensionTo: number;
}

function asFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRelationDeltas(event: GroupEvent): RelationDelta[] {
  if (event.type !== "relation_changed") return [];
  const payload = event.payload as Record<string, unknown>;
  const rawChanges = payload.changes;
  if (!Array.isArray(rawChanges)) return [];

  const deltas: RelationDelta[] = [];
  for (const item of rawChanges) {
    const candidate = item as Record<string, unknown>;
    const fromPersonaId =
      typeof candidate.fromPersonaId === "string"
        ? candidate.fromPersonaId
        : "";
    const toPersonaId =
      typeof candidate.toPersonaId === "string" ? candidate.toPersonaId : "";
    const trust = candidate.trust as Record<string, unknown> | undefined;
    const affinity = candidate.affinity as Record<string, unknown> | undefined;
    const tension = candidate.tension as Record<string, unknown> | undefined;
    const trustFrom = asFiniteNumber(trust?.from);
    const trustTo = asFiniteNumber(trust?.to);
    const affinityFrom = asFiniteNumber(affinity?.from);
    const affinityTo = asFiniteNumber(affinity?.to);
    const tensionFrom = asFiniteNumber(tension?.from);
    const tensionTo = asFiniteNumber(tension?.to);
    if (
      !fromPersonaId ||
      !toPersonaId ||
      trustFrom === null ||
      trustTo === null ||
      affinityFrom === null ||
      affinityTo === null ||
      tensionFrom === null ||
      tensionTo === null
    ) {
      continue;
    }
    deltas.push({
      fromPersonaId,
      toPersonaId,
      trustFrom,
      trustTo,
      affinityFrom,
      affinityTo,
      tensionFrom,
      tensionTo,
    });
  }

  return deltas;
}

function formatSignedDelta(next: number, prev: number) {
  const delta = next - prev;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta}`;
}

function buildRelationDetails(
  deltas: RelationDelta[],
  personaNameById: Record<string, string>,
) {
  if (deltas.length === 0) return "";
  const lines: string[] = [];
  for (const delta of deltas) {
    const fromName =
      personaNameById[delta.fromPersonaId] || delta.fromPersonaId;
    const toName = personaNameById[delta.toPersonaId] || delta.toPersonaId;
    lines.push(`${fromName} -> ${toName}`);
    lines.push(
      `trust ${delta.trustFrom} -> ${delta.trustTo} (${formatSignedDelta(
        delta.trustTo,
        delta.trustFrom,
      )})`,
    );
    lines.push(
      `affinity ${delta.affinityFrom} -> ${delta.affinityTo} (${formatSignedDelta(
        delta.affinityTo,
        delta.affinityFrom,
      )})`,
    );
    lines.push(
      `tension ${delta.tensionFrom} -> ${delta.tensionTo} (${formatSignedDelta(
        delta.tensionTo,
        delta.tensionFrom,
      )})`,
    );
    lines.push("");
  }
  return lines.join("\n").trim();
}

type GroupLogViewMode = "literary" | "technical" | "deltas";

const ORCHESTRATOR_REASON_LABELS: Record<string, string> = {
  room_not_active: "Комната не активна",
  waiting_for_user: "Ожидание ответа пользователя",
  pending_image_generation: "Ожидание генерации изображения",
  typing_delay: "Пауза перед ответом",
  no_active_participants: "Нет активных участников",
  speaker_not_found: "Спикер не найден",
  speaker_selected: "Спикер выбран",
  llm_generation_failed: "Ошибка генерации ответа",
  empty_llm_speech: "Модель вернула пустой ответ",
  invalid_raw_speaker_pattern: "Нарушен формат реплики",
  duplicate_llm_speech: "Дубликат реплики",
  user_replied: "Пользователь ответил",
  user_message: "Сообщение пользователя получено",
  tick_started: "Запущен тик оркестратора",
  orchestrator_resumed: "Оркестратор продолжил работу",
  manual_pause: "Пауза включена вручную",
  manual_resume: "Пауза снята вручную",
  tick_exception: "Исключение в тике оркестратора",
};

interface LiteraryLogEntry {
  id: string;
  createdAt: string;
  title: string;
  reason: string;
  reasonType: string;
  details: string;
}

interface StatusDeltaLogEntry {
  id: string;
  createdAt: string;
  title: string;
  details: string;
  reason: string;
  reasonType: string;
}

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadNumber(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractEventReason(event: GroupEvent) {
  const payload = event.payload ?? {};
  const reason = payloadString(payload, "reason");
  return reason.trim();
}

function toSystemReasonType(reason: string) {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return "";
  if (ORCHESTRATOR_REASON_LABELS[normalized]) return normalized;
  const codeMatch = /^[a-z0-9_]+$/u.test(normalized);
  if (codeMatch) return normalized;
  const prefixMatch = normalized.match(/^([a-z0-9_]+):/u);
  if (prefixMatch?.[1]) return prefixMatch[1];
  return "";
}

function formatReasonLabel(reason: string) {
  if (!reason) return "";
  const normalized = reason.trim();
  if (!normalized) return "";
  const fromCatalog = ORCHESTRATOR_REASON_LABELS[normalized];
  if (fromCatalog) return fromCatalog;
  return normalized.replace(/[_-]+/g, " ");
}

function isPauseReason(reason: string) {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized === "typing_delay" ||
    normalized === "manual_pause" ||
    normalized === "manual_resume" ||
    normalized === "bootstrap_pause"
  ) {
    return true;
  }
  return normalized.includes("pause") || normalized.includes("пауз");
}

function isNonLiteraryReason(reason: string) {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized === "pending_image_generation" ||
    normalized === "image_generation_pending"
  ) {
    return true;
  }
  return normalized.includes("ожидание генерации изображения");
}

function buildLiteraryLogEntries(events: GroupEvent[]) {
  const entries: LiteraryLogEntry[] = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.type === "orchestrator_tick_started") {
      const reason = payloadString(payload, "reason");
      if (!reason) continue;
      if (isPauseReason(reason) || isNonLiteraryReason(reason)) continue;
      const source = payloadString(payload, "source");
      const status = payloadString(payload, "status");
      const details = [
        source ? `Источник: ${source}` : "",
        status ? `Статус: ${status}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Тик оркестратора",
        reason,
        reasonType: toSystemReasonType(reason),
        details,
      });
      continue;
    }
    if (event.type === "room_waiting_user") {
      const reason = payloadString(payload, "reason");
      if (!reason) continue;
      if (isPauseReason(reason) || isNonLiteraryReason(reason)) continue;
      const userName = payloadString(payload, "userName");
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Ожидание пользователя",
        reason,
        reasonType: toSystemReasonType(reason),
        details: userName ? `Ожидается: ${userName}` : "",
      });
      continue;
    }
    if (event.type === "room_resumed") {
      const reason = payloadString(payload, "reason");
      if (!reason) continue;
      if (isPauseReason(reason) || isNonLiteraryReason(reason)) continue;
      const by = payloadString(payload, "by");
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Возобновление комнаты",
        reason,
        reasonType: toSystemReasonType(reason),
        details: by ? `Инициатор: ${by}` : "",
      });
      continue;
    }
    if (event.type === "orchestrator_invariant_blocked") {
      const reason = payloadString(payload, "reason");
      if (!reason) continue;
      if (isPauseReason(reason) || isNonLiteraryReason(reason)) continue;
      const speakerPersonaId = payloadString(payload, "speakerPersonaId");
      const details = speakerPersonaId
        ? `Персона: ${speakerPersonaId}`
        : "Нарушение инварианта";
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Блокировка инварианта",
        reason,
        reasonType: toSystemReasonType(reason),
        details,
      });
    }
  }
  return entries.slice(-80);
}

function buildStatusDeltaLogEntries(events: GroupEvent[]) {
  const entries: StatusDeltaLogEntry[] = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.type === "orchestrator_tick_started") {
      const status = payloadString(payload, "status");
      const reason = payloadString(payload, "reason");
      if (!status && !reason) continue;
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: `Статус тика: ${status || "unknown"}`,
        details: reason ? `reason: ${reason}` : "",
        reason,
        reasonType: toSystemReasonType(reason),
      });
      continue;
    }
    if (event.type === "room_waiting_user") {
      const reason = payloadString(payload, "reason");
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "waitingForUser: false -> true",
        details: reason ? `reason: ${reason}` : "",
        reason,
        reasonType: toSystemReasonType(reason),
      });
      continue;
    }
    if (event.type === "room_resumed") {
      const status = payloadString(payload, "status");
      const reason = payloadString(payload, "reason");
      const title = status
        ? `Статус комнаты -> ${status}`
        : "waitingForUser: true -> false";
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title,
        details: reason ? `reason: ${reason}` : "",
        reason,
        reasonType: toSystemReasonType(reason),
      });
      continue;
    }
    if (event.type === "room_paused") {
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Статус комнаты: active -> paused",
        details: "",
        reason: "",
        reasonType: "",
      });
      continue;
    }
    if (event.type === "speaker_selected") {
      const personaName = payloadString(payload, "personaName");
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Фаза: orchestrating -> committing",
        details: personaName ? `Спикер: ${personaName}` : "",
        reason: "",
        reasonType: "",
      });
      continue;
    }
    if (event.type === "orchestrator_invariant_blocked") {
      const reason = payloadString(payload, "reason");
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Фаза: generating -> error",
        details: reason ? `reason: ${reason}` : "",
        reason,
        reasonType: toSystemReasonType(reason),
      });
      continue;
    }
    if (event.type === "message_image_requested") {
      const expected = payloadNumber(payload, "expected");
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Генерация изображений: pending",
        details: Number.isFinite(expected) ? `expected: ${expected}` : "",
        reason: "",
        reasonType: "",
      });
      continue;
    }
    if (event.type === "message_image_generated") {
      entries.push({
        id: event.id,
        createdAt: event.createdAt,
        title: "Генерация изображений: completed",
        details: "",
        reason: "",
        reasonType: "",
      });
    }
  }
  return entries.slice(-120).reverse();
}

function buildImageRetryBlockOptions(message: GroupMessage) {
  const descriptionBlocks = (message.comfyImageDescriptions ??
    (message.comfyImageDescription ? [message.comfyImageDescription] : []))
    .map((value) => value.trim())
    .filter(Boolean);
  const promptBlocks = (message.comfyPrompts ??
    (message.comfyPrompt ? [message.comfyPrompt] : []))
    .map((value) => value.trim())
    .filter(Boolean);
  const count = Math.max(descriptionBlocks.length, promptBlocks.length);
  return Array.from({ length: count }, (_, index) => {
    const source = descriptionBlocks[index] || promptBlocks[index] || "";
    return {
      index,
      label: source ? compactText(source, 96) : `Блок #${index + 1}`,
    };
  });
}

function parseIdbAssetId(value: string) {
  const normalized = value.trim();
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

export function GroupChatPane({
  activeRoom,
  participants,
  messages,
  events,
  personas,
  inputValue,
  setInputValue,
  isLoading,
  controlsDisabled,
  showSystemImageBlock,
  showStatusChangeDetails,
  onStartRoom,
  onPauseRoom,
  onRunIteration,
  onDeleteRoom,
  onSubmitMessage,
  onRetryMessageImages,
  onRegenerateMessageResponse,
  onOpenChatDetails,
}: GroupChatPaneProps) {
  const [eventLogModalOpen, setEventLogModalOpen] = useState(false);
  const [eventLogMode, setEventLogMode] = useState<GroupLogViewMode>(
    "technical",
  );
  const [hiddenReasonTypes, setHiddenReasonTypes] = useState<string[]>([]);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<
    ImageGenerationMeta | undefined
  >(undefined);
  const [previewTarget, setPreviewTarget] = useState<{
    messageId: string;
    sourceUrl: string;
    sourceIndex: number;
  } | null>(null);
  const [avatarByPersonaId, setAvatarByPersonaId] = useState<
    Record<string, string>
  >({});
  const [resolvedImageBySource, setResolvedImageBySource] = useState<
    Record<string, string>
  >({});
  const [imageRetryDialog, setImageRetryDialog] = useState<{
    messageId: string;
    options: Array<{ index: number; label: string }>;
    selected: number[];
  } | null>(null);
  const [profilePersonaId, setProfilePersonaId] = useState<string | null>(null);
  const composerWrapperRef = useRef<HTMLDivElement | null>(null);
  const messageIds = useMemo(() => messages.map((message) => message.id), [messages]);
  const {
    messagesContainerRef,
    endRef,
    unreadCount,
    jumpToLatest,
    onMessagesScroll,
  } = useSmartMessageAutoscroll({
    streamType: "group",
    streamId: activeRoom?.id ?? null,
    messageIds,
    nearBottomThresholdPx: 80,
    overlayRef: composerWrapperRef,
    bottomObscurerSelector: ".mobile-bottom-nav",
    bottomOverlayGapPx: 12,
  });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const personaWithImageIds = personas
        .map((persona) => ({
          personaId: persona.id,
          imageId: resolvePersonaAvatarImageId(persona),
        }))
        .filter((item) => item.imageId);

      if (personaWithImageIds.length === 0) {
        if (!cancelled) setAvatarByPersonaId({});
        return;
      }

      const assets = await dbApi.getImageAssets(
        personaWithImageIds.map((item) => item.imageId),
      );
      if (cancelled) return;

      const assetById = Object.fromEntries(
        assets.map((asset) => [asset.id, asset.dataUrl]),
      );
      setAvatarByPersonaId(
        Object.fromEntries(
          personaWithImageIds.map((item) => [
            item.personaId,
            assetById[item.imageId] ?? "",
          ]),
        ),
      );
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [personas]);

  useEffect(() => {
    let cancelled = false;
    const loadAttachmentAssets = async () => {
      const refsById = new Map<string, string[]>();
      const nextResolved: Record<string, string> = {};
      for (const message of messages) {
        const attachments = message.imageAttachments ?? [];
        for (const attachment of attachments) {
          const sourceUrl = attachment.url.trim();
          if (!sourceUrl) continue;
          const directId =
            attachment.imageId?.trim() || parseIdbAssetId(sourceUrl);
          if (!directId) {
            nextResolved[sourceUrl] = sourceUrl;
            continue;
          }
          const bucket = refsById.get(directId) ?? [];
          bucket.push(sourceUrl);
          refsById.set(directId, bucket);
        }
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
  }, [messages]);

  useEffect(() => {
    if (!previewTarget) return;
    const message = messages.find(
      (candidate) => candidate.id === previewTarget.messageId,
    );
    if (!message) return;
    const attachments = message.imageAttachments ?? [];
    if (attachments.length === 0) return;

    const preferredByIndex = attachments[previewTarget.sourceIndex]?.url ?? "";
    const preferredBySource = attachments.some(
      (attachment) => attachment.url === previewTarget.sourceUrl,
    )
      ? previewTarget.sourceUrl
      : "";
    const nextSourceUrl =
      preferredByIndex ||
      preferredBySource ||
      attachments[0]?.url ||
      "";

    if (!nextSourceUrl) {
      return;
    }
    const nextPreviewSrc =
      resolvedImageBySource[nextSourceUrl] ??
      (parseIdbAssetId(nextSourceUrl) ? "" : nextSourceUrl);
    if (nextPreviewSrc && nextPreviewSrc === previewSrc) return;

    const resolvedMeta =
      attachments.find((attachment) => attachment.url === nextSourceUrl)?.meta ??
      message.imageMetaByUrl?.[nextSourceUrl];

    setPreviewSrc(nextPreviewSrc || null);
    setPreviewMeta(resolvedMeta);
    setPreviewTarget((prev) =>
      prev
        ? {
          ...prev,
            sourceUrl: nextSourceUrl,
          }
        : prev,
    );
  }, [messages, previewTarget, previewSrc, resolvedImageBySource]);

  const participantCount = participants.length;
  const technicalEvents = useMemo(
    () => [...events].slice(-40).reverse(),
    [events],
  );
  const literaryEntries = useMemo(() => buildLiteraryLogEntries(events), [events]);
  const deltaEntries = useMemo(() => buildStatusDeltaLogEntries(events), [events]);
  const availableReasonTypes = useMemo(() => {
    const reasons = new Set<string>();
    for (const event of events) {
      const reason = extractEventReason(event);
      const reasonType = toSystemReasonType(reason);
      if (reasonType) reasons.add(reasonType);
    }
    return Array.from(reasons).sort((a, b) =>
      formatReasonLabel(a).localeCompare(formatReasonLabel(b), "ru"),
    );
  }, [events]);
  const hiddenReasonSet = useMemo(
    () => new Set(hiddenReasonTypes),
    [hiddenReasonTypes],
  );
  const filteredTechnicalEvents = useMemo(
    () =>
      technicalEvents.filter((event) => {
        const reason = extractEventReason(event);
        const reasonType = toSystemReasonType(reason);
        if (!reasonType) return true;
        return !hiddenReasonSet.has(reasonType);
      }),
    [technicalEvents, hiddenReasonSet],
  );
  const filteredLiteraryEntries = useMemo(
    () => literaryEntries.filter((entry) => !hiddenReasonSet.has(entry.reasonType)),
    [literaryEntries, hiddenReasonSet],
  );
  const filteredDeltaEntries = useMemo(
    () =>
      deltaEntries.filter((entry) =>
        entry.reasonType ? !hiddenReasonSet.has(entry.reasonType) : true,
      ),
    [deltaEntries, hiddenReasonSet],
  );
  const modeLabel =
    activeRoom?.mode === "personas_plus_user"
      ? "Персоны + пользователь"
      : "Только персоны";

  const personaById = useMemo(
    () => Object.fromEntries(personas.map((persona) => [persona.id, persona])),
    [personas],
  );
  const profilePersona = profilePersonaId ? personaById[profilePersonaId] ?? null : null;
  const personaNameById = useMemo(
    () =>
      Object.fromEntries(personas.map((persona) => [persona.id, persona.name])),
    [personas],
  );
  const mentionTargetResolver = useMemo(() => {
    const buckets = new Map<string, string[]>();
    const pushAlias = (alias: string, personaId: string) => {
      if (!alias) return;
      const key = alias.trim().toLowerCase();
      if (!key) return;
      const current = buckets.get(key) ?? [];
      current.push(personaId);
      buckets.set(key, current);
    };
    for (const persona of personas) {
      const tokens = persona.name
        .trim()
        .toLowerCase()
        .split(/[\s_-]+/g)
        .map((value) => value.trim())
        .filter((value) => value.length >= 2);
      const full = persona.name.trim().toLowerCase();
      if (full) {
        for (const form of buildRussianMentionForms(full)) {
          pushAlias(form, persona.id);
        }
      }
      for (const token of tokens) {
        for (const form of buildRussianMentionForms(token)) {
          pushAlias(form, persona.id);
        }
      }
    }
    return (rawLabel: string): GroupMessageMention["targetType"] => {
      const token = normalizeMentionToken(rawLabel);
      if (!token) return "group";
      if (token === "user" || token === "пользователь") {
        return "user";
      }
      if (token === "all" || token === "everyone" || token === "все") {
        return "group";
      }
      const matches = buckets.get(token) ?? [];
      return matches.length === 1 ? "persona" : "group";
    };
  }, [personas]);
  const relationDeltasByTurnId = useMemo(() => {
    const next = new Map<string, RelationDelta[]>();
    for (const event of events) {
      if (!event.turnId || event.type !== "relation_changed") continue;
      const parsed = parseRelationDeltas(event);
      if (parsed.length === 0) continue;
      const bucket = next.get(event.turnId) ?? [];
      bucket.push(...parsed);
      next.set(event.turnId, bucket);
    }
    return next;
  }, [events]);
  const imageIssueByMessageId = useMemo(() => {
    const issues = new Map<string, string>();
    for (const event of events) {
      if (event.type !== "message_image_generated") continue;
      const payload = event.payload ?? {};
      const messageId = payloadString(payload, "messageId");
      const status = payloadString(payload, "status");
      if (!messageId || !status) continue;
      if (
        status === "generation_failed" ||
        status === "prompt_generation_failed" ||
        status === "no_prompts"
      ) {
        issues.set(messageId, status);
      }
    }
    return issues;
  }, [events]);
  const messageRenderMetaById = useMemo(() => {
    const byId = new Map<
      string,
      {
        textToRender: string;
        imageAttachments: NonNullable<GroupMessage["imageAttachments"]>;
        comfyImageDescriptionsToRender: string[];
        comfyPromptsToRender: string[];
        statusDetails: string;
        relationDetails: string;
        showRecoveryActions: boolean;
        imageSkeletonCount: number;
        bubbleRole: "user" | "assistant";
        skip: boolean;
      }
    >();

    for (const message of messages) {
      const parsedAssistant =
        message.authorType === "persona"
          ? splitAssistantContent(message.content)
          : undefined;
      const textToRender = parsedAssistant?.visibleText ?? message.content;
      const imageAttachments = message.imageAttachments ?? [];
      const comfyImageDescriptionsToRender =
        message.authorType === "persona" && showSystemImageBlock
          ? (() => {
              const next = [
                ...(message.comfyImageDescriptions ?? []),
                ...(parsedAssistant?.comfyImageDescriptions ?? []),
                ...(message.comfyImageDescription
                  ? [message.comfyImageDescription]
                  : []),
                ...(parsedAssistant?.comfyImageDescription
                  ? [parsedAssistant.comfyImageDescription]
                  : []),
              ]
                .map((value) => value.trim())
                .filter(Boolean);
              return Array.from(new Set(next));
            })()
          : [];
      const comfyPromptsToRender =
        message.authorType === "persona" && showSystemImageBlock
          ? (() => {
              const next = [
                ...(message.comfyPrompts ?? []),
                ...(parsedAssistant?.comfyPrompts ?? []),
                ...(message.comfyPrompt ? [message.comfyPrompt] : []),
                ...(parsedAssistant?.comfyPrompt
                  ? [parsedAssistant.comfyPrompt]
                  : []),
              ]
                .map((value) => value.trim())
                .filter(Boolean);
              return Array.from(new Set(next));
            })()
          : [];
      const personaControlToRender =
        message.authorType === "persona" && showStatusChangeDetails
          ? (parsePersonaControlRaw(message.personaControlRaw) ??
            parsedAssistant?.personaControl)
          : undefined;
      const statusDetails = buildStatusDetails(personaControlToRender);
      const relationDetails =
        showStatusChangeDetails && message.authorType === "persona"
          ? buildRelationDetails(
              relationDeltasByTurnId.get(message.turnId) ?? [],
              personaNameById,
            )
          : "";
      const fallbackExpected = Math.max(
        1,
        comfyPromptsToRender.length ||
          comfyImageDescriptionsToRender.length ||
          (message.comfyPrompt ? 1 : 0) ||
          (message.comfyImageDescription ? 1 : 0),
      );
      const hasTrackedImageGeneration = Boolean(
        message.imageGenerationExpected !== undefined ||
          message.imageGenerationCompleted !== undefined ||
          message.imageGenerationPending,
      );
      const expectedCount =
        message.imageGenerationExpected ??
        (hasTrackedImageGeneration ? fallbackExpected : 0);
      const completedCount =
        message.imageGenerationCompleted ??
        (hasTrackedImageGeneration ? imageAttachments.length : 0);
      const hasCountMismatchIssue =
        hasTrackedImageGeneration &&
        !message.imageGenerationPending &&
        expectedCount > completedCount;
      const hasImageIssue =
        imageIssueByMessageId.has(message.id) || hasCountMismatchIssue;
      const showRecoveryActions =
        message.authorType === "persona" && hasImageIssue;
      const imageSkeletonCount = Math.max(0, expectedCount - completedCount);
      const skip =
        !textToRender &&
        comfyImageDescriptionsToRender.length === 0 &&
        comfyPromptsToRender.length === 0 &&
        imageAttachments.length === 0 &&
        !message.imageGenerationPending &&
        !statusDetails &&
        !relationDetails;

      byId.set(message.id, {
        textToRender,
        imageAttachments,
        comfyImageDescriptionsToRender,
        comfyPromptsToRender,
        statusDetails,
        relationDetails,
        showRecoveryActions,
        imageSkeletonCount,
        bubbleRole: message.authorType === "user" ? "user" : "assistant",
        skip,
      });
    }

    return byId;
  }, [
    imageIssueByMessageId,
    messages,
    personaNameById,
    relationDeltasByTurnId,
    showStatusChangeDetails,
    showSystemImageBlock,
  ]);

  const resolveAvatar = (message: GroupMessage) => {
    if (message.authorType === "persona" && message.authorPersonaId) {
      const fromAsset = avatarByPersonaId[message.authorPersonaId];
      if (fromAsset) return fromAsset;
      const persona = personaById[message.authorPersonaId];
      if (!persona) return message.authorAvatarUrl ?? "";
      const raw = resolvePersonaExternalAvatarUrl(persona);
      if (raw) return raw;
      return message.authorAvatarUrl ?? "";
    }
    return message.authorAvatarUrl ?? "";
  };

  const participantPersonaCards = participants
    .map((participant) => {
      const persona = personaById[participant.personaId];
      if (!persona) return null;
      const avatar = avatarByPersonaId[participant.personaId];
      const raw = resolvePersonaExternalAvatarUrl(persona);
      const avatarSrc = avatar || raw;
      return {
        id: participant.id,
        personaId: participant.personaId,
        name: persona.name,
        avatarSrc,
      };
    })
    .filter((value): value is { id: string; personaId: string; name: string; avatarSrc: string } =>
      Boolean(value),
    );

  useEffect(() => {
    if (!eventLogModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEventLogModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [eventLogModalOpen]);

  return (
    <main className="chat group-chat">
      <header className="chat-header">
        <div>
          <h2>
            <button
              type="button"
              className="chat-title-btn"
              onClick={onOpenChatDetails}
              title="Открыть детали группового чата"
            >
              {activeRoom?.title ?? "Группы"}
            </button>
          </h2>
          <div className="group-room-meta">
            <span>{modeLabel}</span>
            <span className="dot" />
            <span>
              <Users size={14} /> {participantCount}
            </span>
          </div>
          {participantPersonaCards.length > 0 ? (
            <div
              className="group-participants-strip"
              aria-label="Участники группы"
            >
              {participantPersonaCards.map((item) => (
                <span
                  key={item.id}
                  className="group-participant-pill"
                  title={item.name}
                >
                  <button
                    type="button"
                    className="profile-avatar-btn"
                    onClick={() => setProfilePersonaId(item.personaId)}
                    aria-label={`Открыть профиль персоны ${item.name}`}
                    title={`Открыть профиль ${item.name}`}
                  >
                    <span className="group-avatar" aria-hidden="true">
                      {item.avatarSrc ? (
                        <img src={item.avatarSrc} alt="" loading="lazy" />
                      ) : (
                        <span>{item.name.trim().charAt(0).toUpperCase()}</span>
                      )}
                    </span>
                  </button>
                  <span>{item.name}</span>
                </span>
              ))}
            </div>
          ) : null}
          {activeRoom?.waitingForUser ? (
            <p className="group-waiting-indicator">
              {activeRoom.waitingReason || "Ожидание ответа пользователя"}
            </p>
          ) : null}
        </div>
        <div className="group-header-controls">
          <button
            type="button"
            className="mini"
            onClick={onStartRoom}
            disabled={
              !activeRoom || controlsDisabled || activeRoom.status === "active"
            }
            title="Запустить групповую комнату"
          >
            <Play size={14} /> <span>Пуск</span>
          </button>
          <button
            type="button"
            className="mini"
            onClick={onPauseRoom}
            disabled={
              !activeRoom || controlsDisabled || activeRoom.status === "paused"
            }
            title="Поставить комнату на паузу"
          >
            <Pause size={14} /> <span>Пауза</span>
          </button>
          <button
            type="button"
            className="mini"
            onClick={onRunIteration}
            disabled={!activeRoom || controlsDisabled}
            title="Сделать одну итерацию оркестратора"
          >
            <StepForward size={14} /> <span>Итер.</span>
          </button>
          <button
            type="button"
            className={`mini ${eventLogModalOpen ? "active" : ""}`}
            onClick={() => setEventLogModalOpen(true)}
            title="Открыть настройки отображения лога"
          >
            <ScrollText size={14} />
            <span>Лог {events.length}</span>
          </button>
          {activeRoom ? (
            <button
              type="button"
              className="icon-btn danger mini"
              onClick={onDeleteRoom}
              disabled={controlsDisabled}
              title="Удалить групповой чат"
            >
              <Trash2 size={14} />
            </button>
          ) : null}
        </div>
      </header>
      {eventLogModalOpen ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setEventLogModalOpen(false)}
        >
          <div
            className="modal large group-log-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h3>Лог оркестратора</h3>
                <p className="modal-subtitle">Режим отображения событий группы</p>
              </div>
              <button type="button" onClick={() => setEventLogModalOpen(false)}>
                <X size={14} /> Закрыть
              </button>
            </div>
            <div className="group-log-mode-tabs" role="tablist" aria-label="Режимы лога">
              <button
                type="button"
                role="tab"
                aria-selected={eventLogMode === "literary"}
                className={eventLogMode === "literary" ? "active" : ""}
                onClick={() => setEventLogMode("literary")}
              >
                Литературный
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={eventLogMode === "technical"}
                className={eventLogMode === "technical" ? "active" : ""}
                onClick={() => setEventLogMode("technical")}
              >
                Технический
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={eventLogMode === "deltas"}
                className={eventLogMode === "deltas" ? "active" : ""}
                onClick={() => setEventLogMode("deltas")}
              >
                Дельты
              </button>
            </div>
            <div className="group-log-filters">
              <div className="group-log-filter-field">
                <span className="group-log-filter-title">Не показывать type `reason`</span>
                {availableReasonTypes.length === 0 ? (
                  <div className="group-log-filter-empty">
                    Нет reason в текущем логе
                  </div>
                ) : (
                  <div className="group-log-reason-checklist">
                    {availableReasonTypes.map((reason) => (
                      <label key={reason} className="group-log-reason-option">
                        <input
                          type="checkbox"
                          checked={hiddenReasonSet.has(reason)}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setHiddenReasonTypes((prev) => {
                              if (checked) {
                                return prev.includes(reason) ? prev : [...prev, reason];
                              }
                              return prev.filter((value) => value !== reason);
                            });
                          }}
                        />
                        <span>{formatReasonLabel(reason)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="mini"
                onClick={() => setHiddenReasonTypes(availableReasonTypes)}
                disabled={
                  availableReasonTypes.length === 0 ||
                  hiddenReasonTypes.length >= availableReasonTypes.length
                }
              >
                Выбрать все
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => setHiddenReasonTypes([])}
                disabled={hiddenReasonTypes.length === 0}
              >
                Сбросить фильтр
              </button>
            </div>
            <section className="group-log-body" aria-label="Содержимое лога">
              {eventLogMode === "technical" ? (
                filteredTechnicalEvents.length === 0 ? (
                  <p className="empty-state">Событий пока нет.</p>
                ) : (
                  filteredTechnicalEvents.map((event) => (
                    <article key={event.id} className="group-event-item">
                      <div className="group-event-head">
                        <strong>{event.type}</strong>
                        <time>{formatShortTime(event.createdAt)}</time>
                      </div>
                      <pre>{formatEventPayload(event.payload)}</pre>
                    </article>
                  ))
                )
              ) : null}

              {eventLogMode === "literary" ? (
                filteredLiteraryEntries.length === 0 ? (
                  <p className="empty-state">
                    Для литературного режима пока нет reasons оркестратора.
                  </p>
                ) : (
                  filteredLiteraryEntries.map((entry, index) => (
                    <article key={entry.id} className="group-log-literary-item">
                      <div className="group-event-head">
                        <strong>
                          {index + 1}. {entry.title}
                        </strong>
                        <time>{formatShortTime(entry.createdAt)}</time>
                      </div>
                      <p className="group-log-reason">{formatReasonLabel(entry.reason)}</p>
                      {entry.details ? (
                        <p className="group-log-details">{entry.details}</p>
                      ) : null}
                    </article>
                  ))
                )
              ) : null}

              {eventLogMode === "deltas" ? (
                filteredDeltaEntries.length === 0 ? (
                  <p className="empty-state">Изменений статусов пока нет.</p>
                ) : (
                  filteredDeltaEntries.map((entry) => (
                    <article key={entry.id} className="group-log-delta-item">
                      <div className="group-event-head">
                        <strong>{entry.title}</strong>
                        <time>{formatShortTime(entry.createdAt)}</time>
                      </div>
                      {entry.details ? <pre>{entry.details}</pre> : null}
                    </article>
                  ))
                )
              ) : null}
            </section>
          </div>
        </div>
      ) : null}

      <section
        className="messages group-messages"
        ref={messagesContainerRef}
        onScroll={onMessagesScroll}
      >
        {messages.map((message) => {
          const renderMeta = messageRenderMetaById.get(message.id);
          if (!renderMeta || renderMeta.skip) {
            return null;
          }
          const {
            textToRender,
            imageAttachments,
            comfyImageDescriptionsToRender,
            comfyPromptsToRender,
            statusDetails,
            relationDetails,
            showRecoveryActions,
            imageSkeletonCount,
            bubbleRole,
          } = renderMeta;
          const avatarSrc = resolveAvatar(message);
          const authorPersona =
            message.authorType === "persona" && message.authorPersonaId
              ? personaById[message.authorPersonaId] ?? null
              : null;

          return (
            <article
              key={message.id}
              className={`group-message ${message.authorType} ${
                bubbleRole === "user" ? "is-user" : "is-opponent"
              }`}
            >
              <div className="group-author">
                <button
                  type="button"
                  className="profile-avatar-btn"
                  disabled={!authorPersona}
                  onClick={() => {
                    if (!authorPersona) return;
                    setProfilePersonaId(authorPersona.id);
                  }}
                  aria-label={
                    authorPersona
                      ? `Открыть профиль персоны ${authorPersona.name}`
                      : "Профиль недоступен"
                  }
                  title={
                    authorPersona
                      ? `Открыть профиль ${authorPersona.name}`
                      : "Профиль недоступен"
                  }
                >
                  <span className="group-avatar" aria-hidden="true">
                    {avatarSrc ? (
                      <img src={avatarSrc} alt="" loading="lazy" />
                    ) : (
                      <span>
                        {message.authorDisplayName.trim().charAt(0).toUpperCase()}
                      </span>
                    )}
                  </span>
                </button>
                <strong className="group-author-name">
                  {message.authorDisplayName}
                </strong>
              </div>

              <div
                className={`bubble ${bubbleRole} ${
                  showRecoveryActions ? "has-recovery-actions" : ""
                }`}
              >
                {showRecoveryActions ? (
                  <div className="group-bubble-actions">
                    <button
                      type="button"
                      className="icon-btn group-bubble-action-btn"
                      onClick={() => {
                        const options = buildImageRetryBlockOptions(message);
                        if (options.length <= 1) {
                          void onRetryMessageImages(
                            message.id,
                            options.length === 1 ? [0] : undefined,
                          );
                          return;
                        }
                        setImageRetryDialog({
                          messageId: message.id,
                          options,
                          selected: options.map((option) => option.index),
                        });
                      }}
                      disabled={controlsDisabled}
                      title="Перегенерировать изображения"
                      aria-label="Перегенерировать изображения"
                    >
                      <Image size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn group-bubble-action-btn"
                      onClick={() => {
                        void onRegenerateMessageResponse(message.id);
                      }}
                      disabled={controlsDisabled}
                      title="Перегенерировать ответ"
                      aria-label="Перегенерировать ответ"
                    >
                      <RefreshCcw size={14} />
                    </button>
                  </div>
                ) : null}
                {textToRender ? (
                  <p>
                    {renderMessageWithMentions(
                      textToRender,
                      message.mentions,
                      mentionTargetResolver,
                    )}
                  </p>
                ) : null}
                {comfyImageDescriptionsToRender.map((description, index) => (
                  <section
                    key={`${message.id}-img-desc-${index}`}
                    className="comfy-prompt-block"
                    aria-label="ComfyUI image description"
                  >
                    <div className="comfy-prompt-head">
                      {comfyImageDescriptionsToRender.length > 1
                        ? `Image description #${index + 1}`
                        : "Image description"}
                    </div>
                    <pre>{description}</pre>
                  </section>
                ))}
                {comfyPromptsToRender.map((prompt, index) => (
                  <section
                    key={`${message.id}-comfy-${index}`}
                    className="comfy-prompt-block"
                    aria-label="ComfyUI prompt"
                  >
                    <div className="comfy-prompt-head">
                      {comfyPromptsToRender.length > 1
                        ? `ComfyUI prompt #${index + 1}`
                        : "ComfyUI prompt"}
                    </div>
                    <pre>{prompt}</pre>
                  </section>
                ))}
                {imageAttachments.length > 0 ? (
                  <section
                    className="bubble-images"
                    aria-label="Изображения сообщения группы"
                  >
                    {imageAttachments.map((attachment, index) => {
                      const resolvedMeta =
                        attachment.meta ??
                        message.imageMetaByUrl?.[attachment.url];
                      const resolvedAttachmentSrc =
                        resolvedImageBySource[attachment.url] ??
                        (parseIdbAssetId(attachment.url) ? "" : attachment.url);
                      return (
                        <button
                          key={`${message.id}-attachment-${index}`}
                          type="button"
                          className="bubble-image-btn"
                          onClick={() => {
                            setPreviewSrc(resolvedAttachmentSrc || null);
                            setPreviewMeta(resolvedMeta);
                            setPreviewTarget({
                              messageId: message.id,
                              sourceUrl: attachment.url,
                              sourceIndex: index,
                            });
                          }}
                        >
                          {resolvedAttachmentSrc ? (
                            <img
                              src={resolvedAttachmentSrc}
                              alt={`group-generated-${index + 1}`}
                              loading="lazy"
                            />
                          ) : (
                            <div className="image-skeleton-card" />
                          )}
                        </button>
                      );
                    })}
                  </section>
                ) : null}
                {message.imageGenerationPending && imageSkeletonCount > 0 ? (
                  <section
                    className="bubble-images"
                    aria-label="Изображения создаются"
                  >
                    {Array.from({ length: imageSkeletonCount }).map(
                      (_, index) => (
                        <div
                          key={`${message.id}-skeleton-${index}`}
                          className="image-skeleton-card"
                        />
                      ),
                    )}
                  </section>
                ) : null}
                {statusDetails ? (
                  <section
                    className="status-change-block"
                    aria-label="Изменения статуса"
                  >
                    <div className="comfy-prompt-head">Изменения статуса</div>
                    <pre>{statusDetails}</pre>
                  </section>
                ) : null}
                {relationDetails ? (
                  <section
                    className="status-change-block"
                    aria-label="Изменения отношений"
                  >
                    <div className="comfy-prompt-head">Изменения отношений</div>
                    <pre>{relationDetails}</pre>
                  </section>
                ) : null}
                <time>{formatShortTime(message.createdAt)}</time>
              </div>
            </article>
          );
        })}

        {messages.length === 0 ? (
          <p className="empty-state">
            Пока нет сообщений в группе. Начните разговор.
          </p>
        ) : null}
        <div ref={endRef} aria-hidden="true" />
      </section>

      <div className="composer-wrapper" ref={composerWrapperRef}>
        {unreadCount > 0 ? (
          <button
            type="button"
            className="new-messages-btn"
            onClick={jumpToLatest}
          >
            Новые: {unreadCount}
          </button>
        ) : null}
        <form className="composer" onSubmit={onSubmitMessage}>
          <textarea
            placeholder="Сообщение в группу..."
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            rows={1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmitMessage(event as unknown as FormEvent);
              }
            }}
          />
          <button
            type="submit"
            disabled={!activeRoom || !inputValue.trim() || isLoading}
          >
            <SendHorizontal size={20} />
          </button>
        </form>
      </div>
      {imageRetryDialog ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setImageRetryDialog(null)}
        >
          <div
            className="modal group-retry-images-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Выбор блоков изображений</h3>
              <button type="button" onClick={() => setImageRetryDialog(null)}>
                <X size={14} /> Закрыть
              </button>
            </div>
            <div className="group-retry-images-body">
              {imageRetryDialog.options.map((option) => (
                <label key={option.index} className="group-retry-option">
                  <input
                    type="checkbox"
                    checked={imageRetryDialog.selected.includes(option.index)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setImageRetryDialog((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          selected: checked
                            ? prev.selected.includes(option.index)
                              ? prev.selected
                              : [...prev.selected, option.index]
                            : prev.selected.filter((value) => value !== option.index),
                        };
                      });
                    }}
                  />
                  <span>
                    #{option.index + 1} {option.label}
                  </span>
                </label>
              ))}
            </div>
            <div className="group-retry-images-actions">
              <button
                type="button"
                className="mini"
                onClick={() => setImageRetryDialog(null)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="primary"
                disabled={imageRetryDialog.selected.length === 0}
                onClick={() => {
                  const payload = imageRetryDialog;
                  setImageRetryDialog(null);
                  void onRetryMessageImages(
                    payload.messageId,
                    payload.selected.slice().sort((a, b) => a - b),
                  );
                }}
              >
                Перегенерировать
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ImagePreviewModal
        src={previewSrc}
        meta={previewMeta}
        onClose={() => {
          setPreviewSrc(null);
          setPreviewMeta(undefined);
          setPreviewTarget(null);
        }}
      />
      <PersonaProfileModal
        open={Boolean(profilePersona)}
        persona={profilePersona}
        onClose={() => setProfilePersonaId(null)}
      />
    </main>
  );
}

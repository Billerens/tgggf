import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  Pause,
  Play,
  SendHorizontal,
  StepForward,
  Trash2,
  Users,
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
    if (stateDelta.activeTopicsAdd && stateDelta.activeTopicsAdd.length > 0) {
      lines.push(`activeTopicsAdd: ${stateDelta.activeTopicsAdd.join(", ")}`);
    }
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
}: GroupChatPaneProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const [eventLogOpen, setEventLogOpen] = useState(false);
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
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!previewTarget || !previewSrc) return;
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
    const nextSource =
      preferredByIndex ||
      preferredBySource ||
      attachments[0]?.url ||
      previewSrc;

    if (!nextSource || nextSource === previewSrc) {
      return;
    }

    const resolvedMeta =
      attachments.find((attachment) => attachment.url === nextSource)?.meta ??
      message.imageMetaByUrl?.[nextSource];

    setPreviewSrc(nextSource);
    setPreviewMeta(resolvedMeta);
    setPreviewTarget((prev) =>
      prev
        ? {
            ...prev,
            sourceUrl: nextSource,
          }
        : prev,
    );
  }, [messages, previewTarget, previewSrc]);

  const participantCount = participants.length;
  const visibleEvents = useMemo(
    () => [...events].slice(-40).reverse(),
    [events],
  );
  const modeLabel =
    activeRoom?.mode === "personas_plus_user"
      ? "Персоны + пользователь"
      : "Только персоны";

  const personaById = useMemo(
    () => Object.fromEntries(personas.map((persona) => [persona.id, persona])),
    [personas],
  );
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
        name: persona.name,
        avatarSrc,
      };
    })
    .filter((value): value is { id: string; name: string; avatarSrc: string } =>
      Boolean(value),
    );

  return (
    <main className="chat group-chat">
      <header className="chat-header">
        <div>
          <h2>{activeRoom?.title ?? "Группы"}</h2>
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
                  <span className="group-avatar" aria-hidden="true">
                    {item.avatarSrc ? (
                      <img src={item.avatarSrc} alt="" loading="lazy" />
                    ) : (
                      <span>{item.name.trim().charAt(0).toUpperCase()}</span>
                    )}
                  </span>
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
            className={`mini ${eventLogOpen ? "active" : ""}`}
            onClick={() => setEventLogOpen((prev) => !prev)}
            title="Показать лог событий оркестратора"
          >
            <ChevronDown
              size={14}
              style={{
                transform: eventLogOpen ? "rotate(180deg)" : "none",
                transition: "transform 0.15s ease",
              }}
            />
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
      {eventLogOpen ? (
        <section className="group-event-log" aria-label="Лог событий группы">
          {visibleEvents.length === 0 ? (
            <p className="empty-state">Событий пока нет.</p>
          ) : (
            visibleEvents.map((event) => (
              <article key={event.id} className="group-event-item">
                <div className="group-event-head">
                  <strong>{event.type}</strong>
                  <time>{formatShortTime(event.createdAt)}</time>
                </div>
                <pre>{formatEventPayload(event.payload)}</pre>
              </article>
            ))
          )}
        </section>
      ) : null}

      <section className="messages group-messages">
        {messages.map((message) => {
          const parsedAssistant =
            message.authorType === "persona"
              ? splitAssistantContent(message.content)
              : undefined;
          const textToRender = parsedAssistant?.visibleText ?? message.content;
          const avatarSrc = resolveAvatar(message);
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
          const expectedCount =
            message.imageGenerationExpected ?? fallbackExpected;
          const completedCount =
            message.imageGenerationCompleted ?? imageAttachments.length;
          const imageSkeletonCount = Math.max(
            0,
            expectedCount - completedCount,
          );

          if (
            !textToRender &&
            comfyImageDescriptionsToRender.length === 0 &&
            comfyPromptsToRender.length === 0 &&
            imageAttachments.length === 0 &&
            !message.imageGenerationPending &&
            !statusDetails &&
            !relationDetails
          ) {
            return null;
          }

          const bubbleRole =
            message.authorType === "user" ? "user" : "assistant";

          return (
            <article
              key={message.id}
              className={`group-message ${message.authorType} ${
                bubbleRole === "user" ? "is-user" : "is-opponent"
              }`}
            >
              <div className="group-author">
                <span className="group-avatar" aria-hidden="true">
                  {avatarSrc ? (
                    <img src={avatarSrc} alt="" loading="lazy" />
                  ) : (
                    <span>
                      {message.authorDisplayName.trim().charAt(0).toUpperCase()}
                    </span>
                  )}
                </span>
                <strong className="group-author-name">
                  {message.authorDisplayName}
                </strong>
              </div>

              <div className={`bubble ${bubbleRole}`}>
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
                      return (
                        <button
                          key={`${message.id}-attachment-${index}`}
                          type="button"
                          className="bubble-image-btn"
                          onClick={() => {
                            setPreviewSrc(attachment.url);
                            setPreviewMeta(resolvedMeta);
                            setPreviewTarget({
                              messageId: message.id,
                              sourceUrl: attachment.url,
                              sourceIndex: index,
                            });
                          }}
                        >
                          <img
                            src={attachment.url}
                            alt={`group-generated-${index + 1}`}
                            loading="lazy"
                          />
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

      <div className="composer-wrapper">
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
      <ImagePreviewModal
        src={previewSrc}
        meta={previewMeta}
        onClose={() => {
          setPreviewSrc(null);
          setPreviewMeta(undefined);
          setPreviewTarget(null);
        }}
      />
    </main>
  );
}

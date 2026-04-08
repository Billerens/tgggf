import { useEffect, useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { PersonaControlPayload } from "../personaDynamics";
import type {
  AppSettings,
  ChatMessage,
  ChatSession,
  ImageGenerationMeta,
  Persona,
  PersonaMemory,
  PersonaRuntimeState,
} from "../types";
import type {
  LookEnhancePromptOverrides,
  LookEnhanceTarget,
} from "../ui/types";
import { resolveSharedEnhancePromptDefaults } from "../features/image-actions/enhancePromptDefaults";
import { splitAssistantContent } from "../messageContent";
import { ImagePreviewModal } from "./ImagePreviewModal";

interface ChatDetailsModalProps {
  open: boolean;
  chat: ChatSession | null;
  persona: Persona | null;
  messages: ChatMessage[];
  imageMetaByUrl: Record<string, ImageGenerationMeta>;
  memories: PersonaMemory[];
  runtimeState: PersonaRuntimeState | null;
  settings: AppSettings;
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
  onClose: () => void;
}

type DetailsTab = "attachments" | "status";

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

export function ChatDetailsModal({
  open,
  chat,
  persona,
  messages,
  imageMetaByUrl,
  memories,
  runtimeState,
  settings,
  imageActionBusy,
  onEnhanceImage,
  onRegenerateImage,
  onUpdateChatStyleStrength,
  onClose,
}: ChatDetailsModalProps) {
  const [tab, setTab] = useState<DetailsTab>("attachments");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<ImageGenerationMeta | undefined>(undefined);
  const [previewAttachment, setPreviewAttachment] = useState<ImageAttachment | null>(null);
  const [useGlobalStyleStrength, setUseGlobalStyleStrength] = useState(
    typeof chat?.chatStyleStrength !== "number",
  );
  const [chatStyleStrengthDraft, setChatStyleStrengthDraft] = useState(
    typeof chat?.chatStyleStrength === "number"
      ? chat.chatStyleStrength
      : settings.chatStyleStrength,
  );
  const attachments = useMemo(
    () => extractImageAttachments(messages, imageMetaByUrl),
    [messages, imageMetaByUrl],
  );
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
    if (!previewAttachment || !previewSrc) return;
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
      preferredByIndex || preferredBySource || imageUrls[0] || previewSrc;

    if (!nextSource || nextSource === previewSrc) {
      return;
    }

    setPreviewSrc(nextSource);
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
  }, [messages, imageMetaByUrl, previewAttachment, previewSrc]);

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
        </div>

        {tab === "attachments" ? (
          <section className="chat-details-body">
            {attachments.length === 0 ? (
              <p className="empty-state">В этом чате пока нет картинок.</p>
            ) : (
              <div className="attachment-grid">
                {attachments.map((attachment) => (
                  <article key={`${attachment.messageId}-${attachment.src}`} className="attachment-card">
                    <button
                      type="button"
                      className="attachment-preview-btn"
                      onClick={() => {
                        setPreviewSrc(attachment.src);
                        setPreviewMeta(attachment.meta);
                        setPreviewAttachment(attachment);
                      }}
                    >
                      <img src={attachment.src} alt={attachment.alt} loading="lazy" />
                    </button>
                    <div className="attachment-meta">
                      <span>{attachment.role === "assistant" ? "Ассистент" : "Пользователь"}</span>
                      <span>{formatDateTime(attachment.createdAt)}</span>
                    </div>
                    <a
                      href={attachment.src}
                      target="_blank"
                      rel="noreferrer"
                      className="attachment-link"
                    >
                      Открыть <ExternalLink size={14} />
                    </a>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="chat-details-body status-tab">
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
                {runtimeState ? (
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
                  <p>Состояние пока не инициализировано.</p>
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
                  Память ({memories.length}) • short {memoryByLayer.shortTerm.length} • episodic{" "}
                  {memoryByLayer.episodic.length} • long {memoryByLayer.longTerm.length}
                </summary>
                <div className="status-accordion-body">
                  {memories.length === 0 ? (
                    <p className="empty-state">Память по этому чату пока пустая.</p>
                  ) : (
                    <div className="memory-list">
                      {memories.map((memory) => (
                        <article key={memory.id} className="memory-item">
                          <div className="memory-head">
                            <strong>
                              {memory.layer} / {memory.kind}
                            </strong>
                            <span>salience: {memory.salience.toFixed(2)}</span>
                          </div>
                          <p>{memory.content}</p>
                          <time>{formatDateTime(memory.updatedAt)}</time>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            </div>
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

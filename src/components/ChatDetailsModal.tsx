import { useEffect, useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
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
                <h4>Runtime state</h4>
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
                    <p>topics: {runtimeState.activeTopics.join(", ") || "—"}</p>
                    <p>updatedAt: {formatDateTime(runtimeState.updatedAt)}</p>
                  </>
                ) : (
                  <p>Состояние пока не инициализировано.</p>
                )}
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

            <div className="memory-section">
              <h4>Память</h4>
              <p className="memory-summary">
                Всего: {memories.length} | short-term: {memoryByLayer.shortTerm.length} | episodic:{" "}
                {memoryByLayer.episodic.length} | long-term: {memoryByLayer.longTerm.length}
              </p>
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

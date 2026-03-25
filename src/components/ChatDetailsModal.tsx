import { useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { AppSettings, ChatMessage, ChatSession, Persona, PersonaMemory, PersonaRuntimeState } from "../types";

interface ChatDetailsModalProps {
  open: boolean;
  chat: ChatSession | null;
  persona: Persona | null;
  messages: ChatMessage[];
  memories: PersonaMemory[];
  runtimeState: PersonaRuntimeState | null;
  settings: AppSettings;
  onClose: () => void;
}

type DetailsTab = "attachments" | "status";

interface ImageAttachment {
  src: string;
  alt: string;
  messageId: string;
  role: ChatMessage["role"];
  createdAt: string;
}

const IMAGE_URL_REGEX = /(https?:\/\/[^\s)"'<>]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:\?[^\s)"'<>]*)?)/gi;
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gi;

function extractImageAttachments(messages: ChatMessage[]): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];
  const known = new Set<string>();

  for (const message of messages) {
    const text = message.content ?? "";

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
  memories,
  runtimeState,
  settings,
  onClose,
}: ChatDetailsModalProps) {
  const [tab, setTab] = useState<DetailsTab>("attachments");
  const attachments = useMemo(() => extractImageAttachments(messages), [messages]);
  const memoryByLayer = useMemo(() => groupMemories(memories), [memories]);

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
                    <img src={attachment.src} alt={attachment.alt} loading="lazy" />
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
                <p>Показывать ComfyUI: {settings.showSystemImageBlock ? "да" : "нет"}</p>
                <p>Показывать изменения статуса: {settings.showStatusChangeDetails ? "да" : "нет"}</p>
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
    </div>
  );
}


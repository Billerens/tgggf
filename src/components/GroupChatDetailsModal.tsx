import { useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type {
  GroupEvent,
  GroupMemoryPrivate,
  GroupMemoryShared,
  GroupMessage,
  GroupParticipant,
  GroupPersonaState,
  GroupRelationEdge,
  GroupRoom,
  ImageGenerationMeta,
  Persona,
} from "../types";
import { ImagePreviewModal } from "./ImagePreviewModal";

interface GroupChatDetailsModalProps {
  open: boolean;
  room: GroupRoom | null;
  participants: GroupParticipant[];
  messages: GroupMessage[];
  events: GroupEvent[];
  personas: Persona[];
  personaStates: GroupPersonaState[];
  relationEdges: GroupRelationEdge[];
  sharedMemories: GroupMemoryShared[];
  privateMemories: GroupMemoryPrivate[];
  onClose: () => void;
}

type DetailsTab = "attachments" | "status";

interface GroupImageAttachment {
  src: string;
  alt: string;
  meta?: ImageGenerationMeta;
  messageId: string;
  authorDisplayName: string;
  createdAt: string;
}

function formatDateTime(value: string | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function extractGroupImageAttachments(messages: GroupMessage[]): GroupImageAttachment[] {
  const attachments: GroupImageAttachment[] = [];
  const known = new Set<string>();

  for (const message of messages) {
    const messageAttachments = message.imageAttachments ?? [];
    for (const attachment of messageAttachments) {
      const src = (attachment.url ?? "").trim();
      if (!src) continue;
      const key = `${message.id}::${src}`;
      if (known.has(key)) continue;
      known.add(key);
      attachments.push({
        src,
        alt: "Изображение",
        meta: attachment.meta ?? message.imageMetaByUrl?.[src],
        messageId: message.id,
        authorDisplayName: message.authorDisplayName,
        createdAt: message.createdAt,
      });
    }
  }

  return attachments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function GroupChatDetailsModal({
  open,
  room,
  participants,
  messages,
  events,
  personas,
  personaStates,
  relationEdges,
  sharedMemories,
  privateMemories,
  onClose,
}: GroupChatDetailsModalProps) {
  const [tab, setTab] = useState<DetailsTab>("attachments");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<ImageGenerationMeta | undefined>(
    undefined,
  );
  const personaNameById = useMemo(
    () => Object.fromEntries(personas.map((persona) => [persona.id, persona.name])),
    [personas],
  );
  const attachments = useMemo(() => extractGroupImageAttachments(messages), [messages]);
  const imageCount = attachments.length;
  const pendingImageCount = useMemo(
    () => messages.filter((message) => message.imageGenerationPending).length,
    [messages],
  );
  const eventCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of events) {
      map.set(event.type, (map.get(event.type) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [events]);
  const privateMemoryCountByPersona = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of privateMemories) {
      map.set(item.personaId, (map.get(item.personaId) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [privateMemories]);
  const lastMessageAt = messages[messages.length - 1]?.createdAt;

  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal large" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h2>Детали группового чата</h2>
            <p className="modal-subtitle">{room?.title ?? "Группа"}</p>
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
              <p className="empty-state">В этом групповом чате пока нет картинок.</p>
            ) : (
              <div className="attachment-grid">
                {attachments.map((attachment) => (
                  <article
                    key={`${attachment.messageId}-${attachment.src}`}
                    className="attachment-card"
                  >
                    <button
                      type="button"
                      className="attachment-preview-btn"
                      onClick={() => {
                        setPreviewSrc(attachment.src);
                        setPreviewMeta(attachment.meta);
                      }}
                    >
                      <img src={attachment.src} alt={attachment.alt} loading="lazy" />
                    </button>
                    <div className="attachment-meta">
                      <span>{attachment.authorDisplayName}</span>
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
                <p>mode: {room?.mode ?? "—"}</p>
                <p>status: {room?.status ?? "—"}</p>
                <p>phase: {room?.state.phase ?? "—"}</p>
                <p>participants: {participants.length}</p>
                <p>messages: {messages.length}</p>
                <p>images: {imageCount}</p>
                <p>pendingImages: {pendingImageCount}</p>
                <p>events: {events.length}</p>
                <p>lastMessageAt: {formatDateTime(lastMessageAt)}</p>
                <p>lastTickAt: {formatDateTime(room?.lastTickAt)}</p>
                <p>createdAt: {formatDateTime(room?.createdAt)}</p>
                <p>updatedAt: {formatDateTime(room?.updatedAt)}</p>
              </div>

              <div className="status-card">
                <h4>Ожидание пользователя</h4>
                <p>waitingForUser: {room?.waitingForUser ? "да" : "нет"}</p>
                <p>waitingReason: {room?.waitingReason?.trim() || "—"}</p>
                <p>runtimeReason: {room?.state.reason?.trim() || "—"}</p>
                <p>runtimeError: {room?.state.error?.trim() || "—"}</p>
                <p>stateUpdatedAt: {formatDateTime(room?.state.updatedAt)}</p>
              </div>

              <div className="status-card">
                <h4>Память (кратко)</h4>
                <p>shared: {sharedMemories.length}</p>
                <p>private: {privateMemories.length}</p>
              </div>
            </div>

            <div className="status-accordion-list">
              <details className="status-accordion">
                <summary>Состояния персон ({personaStates.length})</summary>
                <div className="status-accordion-body">
                  {personaStates.length === 0 ? (
                    <p>Нет данных.</p>
                  ) : (
                    <div className="memory-list">
                      {personaStates.map((state) => (
                        <article key={state.id} className="memory-item">
                          <div className="memory-head">
                            <strong>{personaNameById[state.personaId] ?? state.personaId}</strong>
                            <span>{formatDateTime(state.updatedAt)}</span>
                          </div>
                          <p>
                            mood: {state.mood} | trust: {state.trustToUser} | engagement:{" "}
                            {state.engagement} | energy: {state.energy}
                          </p>
                          <p>
                            initiative: {state.initiative} | affection: {state.affectionToUser} |
                            tension: {state.tension}
                          </p>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </details>

              <details className="status-accordion">
                <summary>Связи между персонами ({relationEdges.length})</summary>
                <div className="status-accordion-body">
                  {relationEdges.length === 0 ? (
                    <p>Нет данных.</p>
                  ) : (
                    <div className="memory-list">
                      {relationEdges.map((edge) => (
                        <article key={edge.id} className="memory-item">
                          <div className="memory-head">
                            <strong>
                              {personaNameById[edge.fromPersonaId] ?? edge.fromPersonaId} →{" "}
                              {personaNameById[edge.toPersonaId] ?? edge.toPersonaId}
                            </strong>
                            <span>{formatDateTime(edge.updatedAt)}</span>
                          </div>
                          <p>
                            trust: {edge.trust} | respect: {edge.respect} | affinity:{" "}
                            {edge.affinity}
                          </p>
                          <p>
                            tension: {edge.tension} | influence: {edge.influence} | attraction:{" "}
                            {edge.attraction}
                          </p>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </details>

              <details className="status-accordion">
                <summary>Статистика событий ({events.length})</summary>
                <div className="status-accordion-body">
                  {eventCounts.length === 0 ? (
                    <p>Нет данных.</p>
                  ) : (
                    <ul className="status-list">
                      {eventCounts.map(([type, count]) => (
                        <li key={type}>
                          {type}: {count}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>

              <details className="status-accordion">
                <summary>Память (детально)</summary>
                <div className="status-accordion-body">
                  <p>shared: {sharedMemories.length}</p>
                  <p>private: {privateMemories.length}</p>

                  <div className="status-subsection">
                    <p className="status-subtitle">private by persona</p>
                    {privateMemoryCountByPersona.length === 0 ? (
                      <p>—</p>
                    ) : (
                      <ul className="status-list">
                        {privateMemoryCountByPersona.map(([personaId, count]) => (
                          <li key={personaId}>
                            {personaNameById[personaId] ?? personaId}: {count}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </details>
            </div>
          </section>
        )}
      </div>
      <ImagePreviewModal
        src={previewSrc}
        meta={previewMeta}
        onClose={() => {
          setPreviewSrc(null);
          setPreviewMeta(undefined);
        }}
      />
    </div>
  );
}

import type { FormEvent } from "react";
import { SendHorizontal, Trash2, ChevronDown, HeartHandshake, Brain, Database, Zap, Link2 } from "lucide-react";
import { getMoodLabel } from "../personaProfiles";
import type { ChatMessage, ChatSession, Persona, PersonaRuntimeState } from "../types";
import type { PersonaControlPayload } from "../personaDynamics";
import { formatShortTime } from "../ui/format";
import { splitAssistantContent } from "../messageContent";

interface ChatPaneProps {
  activeChat: ChatSession | null;
  activePersona: Persona | null;
  activeChatId: string | null;
  messages: ChatMessage[];
  messageInput: string;
  setMessageInput: (value: string) => void;
  isLoading: boolean;
  activePersonaState: PersonaRuntimeState | null;
  memoryCount: number;
  showSystemImageBlock: boolean;
  showStatusChangeDetails: boolean;
  onDeleteChat: () => void;
  onSubmitMessage: (event: FormEvent) => void;
  onOpenSidebar: () => void;
  onOpenChatDetails: () => void;
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
    if (trust) lines.push(trust);
    if (engagement) lines.push(engagement);
    if (energy) lines.push(energy);
    if (stateDelta.mood) lines.push(`mood: ${stateDelta.mood}`);
    if (stateDelta.relationshipType) lines.push(`relationshipType: ${stateDelta.relationshipType}`);
    if (Number.isFinite(stateDelta.relationshipDepth)) {
      const sign = stateDelta.relationshipDepth && stateDelta.relationshipDepth > 0 ? "+" : "";
      lines.push(`relationshipDepth: ${sign}${stateDelta.relationshipDepth}`);
    }
    if (stateDelta.relationshipStage) lines.push(`relationshipStage: ${stateDelta.relationshipStage}`);
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
      const content = memory.content ? `content="${compactText(memory.content, 100)}"` : "";
      const parts = [byId, kind, layer, content].filter(Boolean);
      lines.push(`- ${parts.join(", ") || "(не указан критерий удаления)"}`);
    }
    if (control.memory_remove.length > 6) {
      lines.push(`- ... ещё ${control.memory_remove.length - 6}`);
    }
  }

  return lines.join("\n");
}

export function ChatPane({
  activeChat,
  activePersona,
  activeChatId,
  messages,
  messageInput,
  setMessageInput,
  isLoading,
  activePersonaState,
  memoryCount,
  showSystemImageBlock,
  showStatusChangeDetails,
  onDeleteChat,
  onSubmitMessage,
  onOpenSidebar,
  onOpenChatDetails,
}: ChatPaneProps) {
  const relationshipBadge =
    activePersonaState
      ? {
          new: "N",
          acquaintance: "A",
          friendly: "F",
          close: "C",
          bonded: "B",
        }[activePersonaState.relationshipStage]
      : "N";

  const moodBadge = activePersonaState
    ? {
        calm: "○",
        warm: "◔",
        playful: "◕",
        focused: "◉",
        analytical: "◇",
        inspired: "✦",
        annoyed: "⚠",
        upset: "☹",
        angry: "⛔",
      }[activePersonaState.mood]
    : "○";

  return (
    <main className="chat">
      <header className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div>
            <h2>
              <button
                type="button"
                className="chat-title-btn"
                onClick={onOpenChatDetails}
                title="Открыть детали чата"
              >
                {activeChat?.title ?? "Новый чат"}
              </button>
            </h2>
            <div className="persona-header-row">
              <div
                className="chat-header-persona"
                onClick={onOpenSidebar}
                title="Сменить персону"
              >
                {activePersona?.name ?? "Не выбрана"} <ChevronDown size={14} />
              </div>
              {activePersonaState ? (
                <div className="persona-state-badges" aria-label="Состояние персоны">
                  <span
                    className="state-pill"
                    title={`Настроение: ${getMoodLabel(activePersonaState.mood)}`}
                    aria-label={`Настроение: ${getMoodLabel(activePersonaState.mood)}`}
                  >
                    <Brain size={18} />
                    <span>{moodBadge}</span>
                  </span>
                  <span
                    className="state-pill"
                    title={`Доверие: ${activePersonaState.trust}`}
                    aria-label={`Доверие: ${activePersonaState.trust}`}
                  >
                    <HeartHandshake size={18} />
                    <span>{activePersonaState.trust}</span>
                  </span>
                  <span
                    className="state-pill"
                    title={`Энергия: ${activePersonaState.energy}`}
                    aria-label={`Энергия: ${activePersonaState.energy}`}
                  >
                    <Zap size={18} />
                    <span>{activePersonaState.energy}</span>
                  </span>
                  <span
                    className="state-pill"
                    title={`Отношения: type=${activePersonaState.relationshipType}, depth=${activePersonaState.relationshipDepth}, stage=${activePersonaState.relationshipStage}`}
                    aria-label={`Отношения: ${activePersonaState.relationshipStage}`}
                  >
                    <Link2 size={18} />
                    <span>{relationshipBadge}</span>
                  </span>
                  <span
                    className="state-pill"
                    title={`Память: ${memoryCount}`}
                    aria-label={`Память: ${memoryCount}`}
                  >
                    <Database size={18} />
                    <span>{memoryCount}</span>
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="header-actions">
          {activeChatId ? (
            <button className="icon-btn danger" type="button" onClick={onDeleteChat} title="Удалить чат">
              <Trash2 size={16} />
            </button>
          ) : null}
        </div>
      </header>

      <section className="messages">
        {messages.map((msg) => {
          const parsed =
            msg.role === "assistant"
              ? splitAssistantContent(msg.content)
              : { visibleText: msg.content };
          const textToRender = parsed.visibleText;
          const comfyPromptToRender =
            msg.role === "assistant" && showSystemImageBlock ? msg.comfyPrompt || parsed.comfyPrompt : undefined;
          const personaControlToRender =
            msg.role === "assistant" && showStatusChangeDetails
              ? parsePersonaControlRaw(msg.personaControlRaw) ?? parsed.personaControl
              : undefined;
          const statusDetails = buildStatusDetails(personaControlToRender);

          if (!textToRender && !comfyPromptToRender && !statusDetails) return null;

          return (
            <article key={msg.id} className={`bubble ${msg.role}`}>
              {textToRender ? <p>{textToRender}</p> : null}
              {comfyPromptToRender ? (
                <section className="comfy-prompt-block" aria-label="ComfyUI prompt">
                  <div className="comfy-prompt-head">ComfyUI prompt</div>
                  <pre>{comfyPromptToRender}</pre>
                </section>
              ) : null}
              {statusDetails ? (
                <section className="status-change-block" aria-label="Изменения статуса">
                  <div className="comfy-prompt-head">Изменения статуса</div>
                  <pre>{statusDetails}</pre>
                </section>
              ) : null}
              <time>{formatShortTime(msg.createdAt)}</time>
            </article>
          );
        })}
        {messages.length === 0 ? (
          <p className="empty-state">Начните диалог: отправьте первое сообщение.</p>
        ) : null}
      </section>

      <div className="composer-wrapper">
        <form className="composer" onSubmit={onSubmitMessage}>
          <textarea
            placeholder="Введите сообщение..."
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmitMessage(e as unknown as FormEvent);
              }
            }}
          />
          <button type="submit" disabled={!messageInput.trim() || !activePersona || isLoading}>
            <SendHorizontal size={20} />
          </button>
        </form>
      </div>
    </main>
  );
}

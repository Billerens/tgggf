import type { FormEvent } from "react";
import { SendHorizontal, Trash2, ChevronDown } from "lucide-react";
import type { ChatMessage, ChatSession, Persona } from "../types";
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
  onDeleteChat: () => void;
  onSubmitMessage: (event: FormEvent) => void;
  onOpenSidebar: () => void;
}

export function ChatPane({
  activeChat,
  activePersona,
  activeChatId,
  messages,
  messageInput,
  setMessageInput,
  isLoading,
  onDeleteChat,
  onSubmitMessage,
  onOpenSidebar,
}: ChatPaneProps) {
  return (
    <main className="chat">
      <header className="chat-header">
        <div>
          <h2>{activeChat?.title ?? "Новый чат"}</h2>
          <div 
            className="chat-header-persona"
            onClick={onOpenSidebar}
            title="Сменить персону"
          >
            {activePersona?.name ?? "Не выбрана"} <ChevronDown size={14} />
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
            msg.role === "assistant" ? msg.comfyPrompt || parsed.comfyPrompt : undefined;
          if (!textToRender && !comfyPromptToRender) return null;

          return (
            <article key={msg.id} className={`bubble ${msg.role}`}>
              {textToRender ? <p>{textToRender}</p> : null}
              {comfyPromptToRender ? (
                <section className="comfy-prompt-block" aria-label="ComfyUI prompt">
                  <div className="comfy-prompt-head">ComfyUI prompt</div>
                  <pre>{comfyPromptToRender}</pre>
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

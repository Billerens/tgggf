import type { FormEvent } from "react";
import { Menu, SendHorizontal, Trash2 } from "lucide-react";
import type { ChatMessage, ChatSession, Persona } from "../types";
import { formatShortTime } from "../ui/format";

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
          <button type="button" className="mobile-menu-btn" onClick={onOpenSidebar}>
            <Menu size={15} /> Меню
          </button>
          <h2>{activeChat?.title ?? "Новый чат"}</h2>
          <p>
            Персона: <strong>{activePersona?.name ?? "Не выбрана"}</strong>
          </p>
        </div>
        <div className="header-actions">
          {activeChatId ? (
            <button className="danger" type="button" onClick={onDeleteChat}>
              <Trash2 size={14} /> Удалить чат
            </button>
          ) : null}
        </div>
      </header>

      <section className="messages">
        {messages.map((msg) => (
          <article key={msg.id} className={`bubble ${msg.role}`}>
            <p>{msg.content}</p>
            <time>{formatShortTime(msg.createdAt)}</time>
          </article>
        ))}
        {messages.length === 0 ? (
          <p className="empty-state">Начните диалог: отправьте первое сообщение.</p>
        ) : null}
      </section>

      <form className="composer" onSubmit={onSubmitMessage}>
        <textarea
          placeholder="Введите сообщение..."
          value={messageInput}
          onChange={(e) => setMessageInput(e.target.value)}
          rows={3}
        />
        <button type="submit" disabled={!activePersona || isLoading}>
          <SendHorizontal size={14} /> Отправить
        </button>
      </form>
    </main>
  );
}

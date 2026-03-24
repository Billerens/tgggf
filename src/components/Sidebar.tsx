import { MessageCircle, Plus, Settings, Users } from "lucide-react";
import type { ChatSession, Persona } from "../types";
import type { SidebarTab } from "../ui/types";
import { formatDate } from "../ui/format";

interface SidebarProps {
  sidebarTab: SidebarTab;
  setSidebarTab: (value: SidebarTab) => void;
  chats: ChatSession[];
  personas: Persona[];
  activeChatId: string | null;
  activePersonaId: string | null;
  onOpenPersonas: () => void;
  onOpenSettings: () => void;
  onCreateChat: () => void;
  onSelectChat: (chatId: string) => void;
  onSelectPersona: (personaId: string) => void;
  onEditPersona: (persona: Persona) => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  sidebarTab,
  setSidebarTab,
  chats,
  personas,
  activeChatId,
  activePersonaId,
  onOpenPersonas,
  onOpenSettings,
  onCreateChat,
  onSelectChat,
  onSelectPersona,
  onEditPersona,
  isMobileOpen,
  onCloseMobile,
}: SidebarProps) {
  return (
    <>
      <aside className={`sidebar ${isMobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-mobile-head">
          <h2>Меню</h2>
          <button type="button" onClick={onCloseMobile}>
            Закрыть
          </button>
        </div>
      <div className="sidebar-header">
        <div>
          <h1>tg-gf</h1>
          <p>Локальный AI-чат</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={onOpenPersonas} title="Персоны">
            <Users size={16} />
          </button>
          <button type="button" onClick={onOpenSettings} title="Настройки">
            <Settings size={16} />
          </button>
        </div>
      </div>

      <div className="sidebar-tabs">
        <button
          type="button"
          className={sidebarTab === "chats" ? "active" : ""}
          onClick={() => setSidebarTab("chats")}
        >
          <MessageCircle size={14} />
          Чаты
        </button>
        <button
          type="button"
          className={sidebarTab === "personas" ? "active" : ""}
          onClick={() => setSidebarTab("personas")}
        >
          <Users size={14} />
          Персоны
        </button>
      </div>

      {sidebarTab === "chats" ? (
        <div className="sidebar-list">
          <div className="list-actions">
            <button type="button" onClick={onCreateChat} disabled={!activePersonaId}>
              <Plus size={14} /> Новый чат
            </button>
          </div>
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`chat-item ${chat.id === activeChatId ? "active" : ""}`}
              onClick={() => {
                onSelectChat(chat.id);
                onCloseMobile();
              }}
            >
              <strong>{chat.title}</strong>
              <span>{formatDate(chat.updatedAt)}</span>
            </button>
          ))}
          {chats.length === 0 ? <p className="sidebar-empty">Чатов пока нет</p> : null}
        </div>
      ) : (
        <div className="sidebar-list">
          {personas.map((persona) => (
            <div
              key={persona.id}
              className={`persona-item ${persona.id === activePersonaId ? "active" : ""}`}
            >
              <button
                type="button"
                className="grow"
                onClick={() => {
                  onSelectPersona(persona.id);
                  onCloseMobile();
                }}
              >
                <strong>{persona.name}</strong>
                <span>{persona.stylePrompt || "Стиль не задан"}</span>
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => {
                  onEditPersona(persona);
                  onCloseMobile();
                }}
              >
                Правка
              </button>
            </div>
          ))}
        </div>
      )}
      </aside>
      {isMobileOpen ? <button className="sidebar-backdrop" onClick={onCloseMobile} /> : null}
    </>
  );
}

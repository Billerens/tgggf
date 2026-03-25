import { MessageCircle, Plus, Settings, Users, X } from "lucide-react";
import { Logo } from "./Logo";
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
  onToggleMobileTab: (tab: SidebarTab) => void;
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
  onToggleMobileTab,
}: SidebarProps) {
  return (
    <>
      <aside className={`sidebar ${isMobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-mobile-head">
          <h2>{sidebarTab === "chats" ? "Чаты" : "Персоны"}</h2>
          <button type="button" className="icon-btn" onClick={onCloseMobile}>
            <X size={20} />
          </button>
        </div>
        
        <div className="sidebar-header">
          <div className="logo-container">
            <Logo size={32} />
            <div>
              <p style={{ margin: 0, fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>Persona Chat</p>
            </div>
          </div>
          <div className="header-actions">
            <button type="button" onClick={onOpenPersonas} title="Управление персонами" className="icon-btn">
              <Users size={16} />
            </button>
            <button type="button" onClick={onOpenSettings} title="Настройки" className="icon-btn">
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
            Чаты
          </button>
          <button
            type="button"
            className={sidebarTab === "personas" ? "active" : ""}
            onClick={() => setSidebarTab("personas")}
          >
            Персоны
          </button>
        </div>

        {sidebarTab === "chats" ? (
          <div className="sidebar-list">
            <div className="list-actions">
              <button type="button" className="primary" onClick={onCreateChat} disabled={!activePersonaId}>
                <Plus size={16} /> Новый чат
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
            {chats.length === 0 ? <p className="empty-state">Чатов пока нет</p> : null}
          </div>
        ) : (
          <div className="sidebar-list">
            {personas.map((persona) => (
              <div
                key={persona.id}
                className={`persona-item ${persona.id === activePersonaId ? "active" : ""}`}
              >
                <div 
                  className="persona-item-content"
                  style={{cursor: 'pointer'}}
                  onClick={() => {
                    onSelectPersona(persona.id);
                    onCloseMobile();
                  }}
                >
                  <strong>{persona.name}</strong>
                  <span>{persona.advanced.core.archetype || persona.stylePrompt || "Стиль не задан"}</span>
                </div>
                <button
                  type="button"
                  className="mini"
                  style={{marginLeft: '8px'}}
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
      
      {/* Mobile Drawer Backdrop */}
      <div className="sidebar-backdrop" onClick={onCloseMobile} />

      {/* Mobile Bottom Navigation */}
      <nav className="mobile-bottom-nav">
        <button
          className={`mobile-nav-btn ${sidebarTab === "chats" && isMobileOpen ? "active" : ""}`}
          onClick={() => onToggleMobileTab("chats")}
        >
          <MessageCircle size={24} />
          Чаты
        </button>
        <button
          className={`mobile-nav-btn ${sidebarTab === "personas" && isMobileOpen ? "active" : ""}`}
          onClick={() => onToggleMobileTab("personas")}
        >
          <Users size={24} />
          Персоны
        </button>
        <button
          className="mobile-nav-btn"
          onClick={() => {
            onCloseMobile();
            onOpenSettings();
          }}
        >
          <Settings size={24} />
          Настройки
        </button>
      </nav>
    </>
  );
}

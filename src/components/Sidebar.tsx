import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ImagePlus,
  MessageCircle,
  Plus,
  Settings,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Logo } from "./Logo";
import { dbApi } from "../db";
import type { ChatSession, GeneratorSession, Persona } from "../types";
import type { SidebarTab } from "../ui/types";
import { formatDate } from "../ui/format";

interface SidebarProps {
  sidebarTab: SidebarTab;
  setSidebarTab: (value: SidebarTab) => void;
  chats: ChatSession[];
  personas: Persona[];
  activeChatId: string | null;
  activePersonaId: string | null;
  generationPersonaId: string;
  generationSessions: GeneratorSession[];
  activeGenerationSessionId: string | null;
  onOpenPersonas: () => void;
  onOpenSettings: () => void;
  onCreateChat: () => void;
  onCreateGenerationSession: () => void;
  onDeleteGenerationSession: (sessionId: string) => void;
  onSelectChat: (chatId: string) => void;
  onSelectGenerationSession: (sessionId: string) => void;
  onSelectPersona: (personaId: string) => void;
  onSelectGenerationPersona: (personaId: string) => void;
  onEditPersona: (persona: Persona) => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
  onToggleMobileTab: (tab: SidebarTab) => void;
}

interface PersonaPickerProps {
  label: string;
  personas: Persona[];
  selectedPersonaId: string | null;
  onSelect: (personaId: string) => void;
}

function PersonaPicker({ label, personas, selectedPersonaId, onSelect }: PersonaPickerProps) {
  const [open, setOpen] = useState(false);
  const [avatarSrcByPersonaId, setAvatarSrcByPersonaId] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedPersona =
    personas.find((persona) => persona.id === selectedPersonaId) ?? null;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const personaWithImageIds = personas
        .filter((persona) => persona.avatarImageId.trim())
        .map((persona) => ({ personaId: persona.id, imageId: persona.avatarImageId.trim() }));
      if (personaWithImageIds.length === 0) {
        if (!cancelled) setAvatarSrcByPersonaId({});
        return;
      }
      const assets = await dbApi.getImageAssets(personaWithImageIds.map((item) => item.imageId));
      if (cancelled) return;
      const assetById = Object.fromEntries(assets.map((asset) => [asset.id, asset.dataUrl]));
      setAvatarSrcByPersonaId(
        Object.fromEntries(
          personaWithImageIds.map((item) => [item.personaId, assetById[item.imageId] ?? ""]),
        ),
      );
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [personas]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const resolveAvatarSrc = (persona: Persona | null) => {
    if (!persona) return "";
    const fromAsset = avatarSrcByPersonaId[persona.id];
    if (fromAsset) return fromAsset;
    const raw = persona.avatarUrl.trim();
    if (!raw || raw.startsWith("idb://")) return "";
    return raw;
  };

  const selectedAvatarSrc = resolveAvatarSrc(selectedPersona);

  return (
    <div className="sidebar-persona-picker" ref={rootRef}>
      <span>{label}</span>
      <button
        type="button"
        className="sidebar-persona-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        <div className="sidebar-item-main">
          <div className="sidebar-avatar" aria-hidden="true">
            {selectedAvatarSrc ? (
              <img src={selectedAvatarSrc} alt="" loading="lazy" />
            ) : (
              <span>{(selectedPersona?.name || "?").trim().charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div className="sidebar-item-text">
            <strong>{selectedPersona?.name || "Выберите персону"}</strong>
          </div>
        </div>
        <ChevronDown size={14} className={`sidebar-picker-chevron ${open ? "open" : ""}`} />
      </button>
      {open ? (
        <div className="sidebar-persona-menu">
          {personas.map((persona) => (
            <button
              key={persona.id}
              type="button"
              className={`sidebar-persona-option ${
                persona.id === selectedPersonaId ? "active" : ""
              }`}
              onClick={() => {
                onSelect(persona.id);
                setOpen(false);
              }}
            >
              <div className="sidebar-avatar" aria-hidden="true">
                {resolveAvatarSrc(persona) ? (
                  <img src={resolveAvatarSrc(persona)} alt="" loading="lazy" />
                ) : (
                  <span>{persona.name.trim().charAt(0).toUpperCase()}</span>
                )}
              </div>
              <div className="sidebar-item-text">
                <strong>{persona.name}</strong>
                <span>{persona.advanced.core.archetype || "Персона"}</span>
              </div>
              {persona.id === selectedPersonaId ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar({
  sidebarTab,
  setSidebarTab,
  chats,
  personas,
  activeChatId,
  activePersonaId,
  generationPersonaId,
  generationSessions,
  activeGenerationSessionId,
  onOpenPersonas,
  onOpenSettings,
  onCreateChat,
  onCreateGenerationSession,
  onDeleteGenerationSession,
  onSelectChat,
  onSelectGenerationSession,
  onSelectPersona,
  onSelectGenerationPersona,
  onEditPersona,
  isMobileOpen,
  onCloseMobile,
  onToggleMobileTab,
}: SidebarProps) {
  const [avatarSrcByPersonaId, setAvatarSrcByPersonaId] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const personaWithImageIds = personas
        .filter((persona) => persona.avatarImageId.trim())
        .map((persona) => ({ personaId: persona.id, imageId: persona.avatarImageId.trim() }));
      if (personaWithImageIds.length === 0) {
        if (!cancelled) setAvatarSrcByPersonaId({});
        return;
      }
      const assets = await dbApi.getImageAssets(personaWithImageIds.map((item) => item.imageId));
      if (cancelled) return;
      const assetById = Object.fromEntries(assets.map((asset) => [asset.id, asset.dataUrl]));
      setAvatarSrcByPersonaId(
        Object.fromEntries(
          personaWithImageIds.map((item) => [item.personaId, assetById[item.imageId] ?? ""]),
        ),
      );
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [personas]);

  const resolveAvatarSrc = (persona: Persona | null) => {
    if (!persona) return "";
    const fromAsset = avatarSrcByPersonaId[persona.id];
    if (fromAsset) return fromAsset;
    const raw = persona.avatarUrl.trim();
    if (!raw || raw.startsWith("idb://")) return "";
    return raw;
  };

  return (
    <>
      <aside className={`sidebar ${isMobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-mobile-head">
          <h2>
            {sidebarTab === "chats"
              ? "Чаты"
              : sidebarTab === "personas"
                ? "Персоны"
                : "Генерация"}
          </h2>
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
          <button
            type="button"
            className={sidebarTab === "generation" ? "active" : ""}
            onClick={() => setSidebarTab("generation")}
          >
            Генерация
          </button>
        </div>

        {sidebarTab === "chats" ? (
          <div className="sidebar-list">
            <PersonaPicker
              label="Текущая персона"
              personas={personas}
              selectedPersonaId={activePersonaId}
              onSelect={onSelectPersona}
            />
            <div className="list-actions">
              <button type="button" className="primary" onClick={onCreateChat} disabled={!activePersonaId}>
                <Plus size={16} /> Новый чат
              </button>
            </div>
            {chats.map((chat) => (
              (() => {
                const chatPersona = personas.find((persona) => persona.id === chat.personaId) ?? null;
                const avatarLetter = (chatPersona?.name || "?").trim().charAt(0).toUpperCase();
                return (
                  <button
                    key={chat.id}
                    type="button"
                    className={`chat-item ${chat.id === activeChatId ? "active" : ""}`}
                    onClick={() => {
                      onSelectChat(chat.id);
                      onCloseMobile();
                    }}
                  >
                    <div className="sidebar-item-main">
                      <div className="sidebar-avatar" aria-hidden="true">
                        {resolveAvatarSrc(chatPersona) ? <img src={resolveAvatarSrc(chatPersona)} alt="" loading="lazy" /> : <span>{avatarLetter}</span>}
                      </div>
                      <div className="sidebar-item-text">
                        <strong>{chat.title}</strong>
                        <span>{formatDate(chat.updatedAt)}</span>
                      </div>
                    </div>
                  </button>
                );
              })()
            ))}
            {chats.length === 0 ? <p className="empty-state">Чатов пока нет</p> : null}
          </div>
        ) : sidebarTab === "personas" ? (
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
                  <div className="sidebar-item-main">
                    <div className="sidebar-avatar" aria-hidden="true">
                      {resolveAvatarSrc(persona) ? <img src={resolveAvatarSrc(persona)} alt="" loading="lazy" /> : <span>{persona.name.trim().charAt(0).toUpperCase()}</span>}
                    </div>
                    <div className="sidebar-item-text">
                      <strong>{persona.name}</strong>
                      <span>{persona.advanced.core.archetype || persona.stylePrompt || "Стиль не задан"}</span>
                    </div>
                  </div>
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
        ) : (
          <div className="sidebar-list">
            <PersonaPicker
              label="Персона генератора"
              personas={personas}
              selectedPersonaId={generationPersonaId || null}
              onSelect={onSelectGenerationPersona}
            />
            <div className="list-actions">
              <button type="button" className="primary" onClick={onCreateGenerationSession}>
                <Plus size={16} /> Новая сессия
              </button>
            </div>
            {generationSessions.map((session) => {
              const sessionPersona =
                personas.find((persona) => persona.id === session.personaId) ?? null;
              const title = session.topic.trim() || "Без темы";
              const avatarLetter = (sessionPersona?.name || "?").trim().charAt(0).toUpperCase();
              return (
                <div
                  key={session.id}
                  className={`chat-item ${session.id === activeGenerationSessionId ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="grow"
                    onClick={() => {
                      onSelectGenerationSession(session.id);
                      onCloseMobile();
                    }}
                  >
                    <div className="sidebar-item-main">
                      <div className="sidebar-avatar" aria-hidden="true">
                        {resolveAvatarSrc(sessionPersona) ? (
                          <img src={resolveAvatarSrc(sessionPersona)} alt="" loading="lazy" />
                        ) : (
                          <span>{avatarLetter}</span>
                        )}
                      </div>
                      <div className="sidebar-item-text">
                        <strong>{title}</strong>
                        <span>
                          {sessionPersona?.name || "Персона"} • {formatDate(session.updatedAt)} •{" "}
                          {session.completedCount}
                        </span>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger mini"
                    onClick={() => onDeleteGenerationSession(session.id)}
                    title="Удалить сессию"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
            {generationSessions.length === 0 ? (
              <p className="empty-state">Сессий генератора пока нет</p>
            ) : null}
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
          className={`mobile-nav-btn ${sidebarTab === "generation" && isMobileOpen ? "active" : ""}`}
          onClick={() => onToggleMobileTab("generation")}
        >
          <ImagePlus size={24} />
          Генерация
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

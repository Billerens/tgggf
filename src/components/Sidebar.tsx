import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ImagePlus,
  MessagesSquare,
  MessageCircle,
  Pencil,
  Plus,
  Settings,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Logo } from "./Logo";
import { RenameModal } from "./RenameModal";
import { dbApi } from "../db";
import type { ChatSession, GeneratorSession, GroupRoom, Persona } from "../types";
import type { SidebarTab } from "../ui/types";
import { formatDate } from "../ui/format";

interface SidebarProps {
  sidebarTab: SidebarTab;
  setSidebarTab: (value: SidebarTab) => void;
  chats: ChatSession[];
  groupRooms: GroupRoom[];
  personas: Persona[];
  activeChatId: string | null;
  activeGroupRoomId: string | null;
  activePersonaId: string | null;
  generationPersonaId: string;
  generationSessions: GeneratorSession[];
  activeGenerationSessionId: string | null;
  onOpenPersonas: () => void;
  onOpenSettings: () => void;
  onCreateChat: () => void;
  onCreateGroupRoom: () => void;
  onCreateGenerationSession: () => void;
  onDeleteGroupRoom: (roomId: string) => void;
  onDeleteGenerationSession: (sessionId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onRenameGroupRoom: (roomId: string, title: string) => void;
  onRenameGenerationSession: (sessionId: string, title: string) => void;
  onSelectChat: (chatId: string) => void;
  onSelectGroupRoom: (roomId: string) => void;
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

type RenameTarget =
  | {
      kind: "chat";
      id: string;
      currentTitle: string;
    }
  | {
      kind: "group";
      id: string;
      currentTitle: string;
    }
  | {
      kind: "generation";
      id: string;
      currentTitle: string;
    };

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
  groupRooms,
  personas,
  activeChatId,
  activeGroupRoomId,
  activePersonaId,
  generationPersonaId,
  generationSessions,
  activeGenerationSessionId,
  onOpenPersonas,
  onOpenSettings,
  onCreateChat,
  onCreateGroupRoom,
  onCreateGenerationSession,
  onDeleteGroupRoom,
  onDeleteGenerationSession,
  onRenameChat,
  onRenameGroupRoom,
  onRenameGenerationSession,
  onSelectChat,
  onSelectGroupRoom,
  onSelectGenerationSession,
  onSelectPersona,
  onSelectGenerationPersona,
  onEditPersona,
  isMobileOpen,
  onCloseMobile,
  onToggleMobileTab,
}: SidebarProps) {
  const [avatarSrcByPersonaId, setAvatarSrcByPersonaId] = useState<Record<string, string>>({});
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);

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

  const renameEntityLabel =
    renameTarget?.kind === "chat"
      ? "чат"
      : renameTarget?.kind === "group"
        ? "групповой чат"
        : renameTarget?.kind === "generation"
          ? "сессия генерации"
          : "";

  const submitRename = (nextTitle: string) => {
    if (!renameTarget) return;
    if (nextTitle === renameTarget.currentTitle.trim()) {
      setRenameTarget(null);
      return;
    }
    if (renameTarget.kind === "chat") {
      onRenameChat(renameTarget.id, nextTitle);
    } else if (renameTarget.kind === "group") {
      onRenameGroupRoom(renameTarget.id, nextTitle);
    } else {
      onRenameGenerationSession(renameTarget.id, nextTitle);
    }
    setRenameTarget(null);
  };

  return (
    <>
      <aside className={`sidebar ${isMobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-mobile-head">
          <h2>
            {sidebarTab === "chats"
              ? "Чаты"
              : sidebarTab === "groups"
                ? "Группы"
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
            title="Чаты"
            aria-label="Чаты"
          >
            <MessageCircle size={18} />
          </button>
          <button
            type="button"
            className={sidebarTab === "groups" ? "active" : ""}
            onClick={() => setSidebarTab("groups")}
            title="Группы"
            aria-label="Группы"
          >
            <MessagesSquare size={18} />
          </button>
          <button
            type="button"
            className={sidebarTab === "personas" ? "active" : ""}
            onClick={() => setSidebarTab("personas")}
            title="Персоны"
            aria-label="Персоны"
          >
            <Users size={18} />
          </button>
          <button
            type="button"
            className={sidebarTab === "generation" ? "active" : ""}
            onClick={() => setSidebarTab("generation")}
            title="Генерация"
            aria-label="Генерация"
          >
            <ImagePlus size={18} />
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
            {chats.map((chat) =>
              (() => {
                const chatPersona =
                  personas.find((persona) => persona.id === chat.personaId) ?? null;
                const avatarLetter = (chatPersona?.name || "?")
                  .trim()
                  .charAt(0)
                  .toUpperCase();
                return (
                  <div
                    key={chat.id}
                    className={`chat-item chat-item-with-action ${
                      chat.id === activeChatId ? "active" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="grow"
                      onClick={() => {
                        onSelectChat(chat.id);
                        onCloseMobile();
                      }}
                    >
                      <div className="sidebar-item-main">
                        <div className="sidebar-avatar" aria-hidden="true">
                          {resolveAvatarSrc(chatPersona) ? (
                            <img src={resolveAvatarSrc(chatPersona)} alt="" loading="lazy" />
                          ) : (
                            <span>{avatarLetter}</span>
                          )}
                        </div>
                        <div className="sidebar-item-text">
                          <strong>{chat.title}</strong>
                          <span>
                            {formatDate(chat.updatedAt)}
                            {chat.notificationsEnabled === false
                              ? " • Уведомления выкл."
                              : ""}
                          </span>
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="icon-btn mini"
                      onClick={() => {
                        setRenameTarget({
                          kind: "chat",
                          id: chat.id,
                          currentTitle: chat.title,
                        });
                      }}
                      title="Переименовать чат"
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                );
              })(),
            )}
            {chats.length === 0 ? <p className="empty-state">Чатов пока нет</p> : null}
          </div>
        ) : sidebarTab === "groups" ? (
          <div className="sidebar-list">
            <div className="list-actions">
              <button type="button" className="primary" onClick={onCreateGroupRoom}>
                <Plus size={16} /> Новая группа
              </button>
            </div>
            {groupRooms.map((room) => (
              <div
                key={room.id}
                className={`chat-item chat-item-with-action ${
                  room.id === activeGroupRoomId ? "active" : ""
                } ${room.status === "active" ? "is-running" : ""}`}
              >
                <button
                  type="button"
                  className="grow"
                  onClick={() => {
                    onSelectGroupRoom(room.id);
                    onCloseMobile();
                  }}
                >
                  <div className="sidebar-item-main">
                    <div className="sidebar-avatar" aria-hidden="true">
                      <span>G</span>
                    </div>
                    <div className="sidebar-item-text">
                      <strong>{room.title}</strong>
                      <span>
                        {room.mode === "personas_plus_user" ? "Персоны + пользователь" : "Только персоны"} •{" "}
                        {formatDate(room.updatedAt)}
                        {room.notificationsEnabled === false
                          ? " • Уведомления выкл."
                          : ""}
                      </span>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  className="icon-btn mini"
                  onClick={() => {
                    setRenameTarget({
                      kind: "group",
                      id: room.id,
                      currentTitle: room.title,
                    });
                  }}
                  title="Переименовать группу"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn danger mini"
                  onClick={() => onDeleteGroupRoom(room.id)}
                  title="Удалить группу"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {groupRooms.length === 0 ? <p className="empty-state">Групп пока нет</p> : null}
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
              const title = session.name.trim() || "Новая сессия";
              const avatarLetter = (sessionPersona?.name || "?").trim().charAt(0).toUpperCase();
              return (
                <div
                  key={session.id}
                  className={`chat-item chat-item-with-action ${
                    session.id === activeGenerationSessionId ? "active" : ""
                  }`}
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
                    className="icon-btn mini"
                    onClick={() => {
                      setRenameTarget({
                        kind: "generation",
                        id: session.id,
                        currentTitle: title,
                      });
                    }}
                    title="Переименовать сессию"
                  >
                    <Pencil size={14} />
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

      <RenameModal
        open={Boolean(renameTarget)}
        entityLabel={renameEntityLabel}
        initialValue={renameTarget?.currentTitle ?? ""}
        onClose={() => setRenameTarget(null)}
        onSubmit={submitRename}
      />

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
          className={`mobile-nav-btn ${sidebarTab === "groups" && isMobileOpen ? "active" : ""}`}
          onClick={() => onToggleMobileTab("groups")}
        >
          <MessagesSquare size={24} />
          Группы
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

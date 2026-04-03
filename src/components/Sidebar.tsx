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
import { Dropdown } from "./Dropdown";
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
  onCreateGroupChat: (personaIds: string[], title?: string) => void;
  onCreateAdventureChat: (
    personaIds: string[],
    scenario: {
      title: string;
      startContext: string;
      initialGoal: string;
      narratorStyle: string;
      worldTone: "light" | "balanced" | "dark";
      explicitnessPolicy: "fade_to_black" | "balanced" | "explicit";
    },
  ) => void;
  onCreateGenerationSession: () => void;
  onDeleteGenerationSession: (sessionId: string) => void;
  onSelectChat: (chatId: string) => void;
  onSelectGenerationSession: (sessionId: string) => void;
  onSelectPersona: (personaId: string) => void;
  onSelectGenerationPersona: (personaId: string) => void;
  onEditPersona: (persona: Persona) => void;
  enableGroupChats: boolean;
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

const ADVENTURE_WORLD_TONE_OPTIONS = [
  { value: "light", label: "Светлый" },
  { value: "balanced", label: "Сбалансированный" },
  { value: "dark", label: "Тёмный" },
] as const;

const ADVENTURE_EXPLICITNESS_OPTIONS = [
  { value: "fade_to_black", label: "Fade to black" },
  { value: "balanced", label: "Balanced" },
  { value: "explicit", label: "Explicit" },
] as const;

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
  onCreateGroupChat,
  onCreateAdventureChat,
  onCreateGenerationSession,
  onDeleteGenerationSession,
  onSelectChat,
  onSelectGenerationSession,
  onSelectPersona,
  onSelectGenerationPersona,
  onEditPersona,
  enableGroupChats,
  isMobileOpen,
  onCloseMobile,
  onToggleMobileTab,
}: SidebarProps) {
  const [avatarSrcByPersonaId, setAvatarSrcByPersonaId] = useState<Record<string, string>>({});
  const [groupBuilderOpen, setGroupBuilderOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupPersonaIds, setGroupPersonaIds] = useState<string[]>([]);
  const [groupPersonaPickerValue, setGroupPersonaPickerValue] = useState("");
  const [adventureBuilderOpen, setAdventureBuilderOpen] = useState(false);
  const [adventureTitle, setAdventureTitle] = useState("");
  const [adventureStartContext, setAdventureStartContext] = useState("");
  const [adventureInitialGoal, setAdventureInitialGoal] = useState("");
  const [adventureNarratorStyle, setAdventureNarratorStyle] = useState("");
  const [adventureWorldTone, setAdventureWorldTone] = useState<"light" | "balanced" | "dark">(
    "balanced",
  );
  const [adventureExplicitnessPolicy, setAdventureExplicitnessPolicy] = useState<
    "fade_to_black" | "balanced" | "explicit"
  >("fade_to_black");
  const [adventurePersonaIds, setAdventurePersonaIds] = useState<string[]>([]);
  const [adventurePersonaPickerValue, setAdventurePersonaPickerValue] = useState("");

  useEffect(() => {
    if (!groupBuilderOpen) return;
    if (!activePersonaId) return;
    setGroupPersonaIds((current) =>
      current.includes(activePersonaId)
        ? current
        : [activePersonaId, ...current.filter((id) => id !== activePersonaId)],
    );
  }, [activePersonaId, groupBuilderOpen]);

  useEffect(() => {
    if (!adventureBuilderOpen) return;
    if (!activePersonaId) return;
    setAdventurePersonaIds((current) =>
      current.includes(activePersonaId)
        ? current
        : [activePersonaId, ...current.filter((id) => id !== activePersonaId)],
    );
  }, [activePersonaId, adventureBuilderOpen]);

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

  const directChats = chats.filter((chat) => chat.mode === "direct");
  const groupChats = chats.filter((chat) => chat.mode === "group");
  const adventureChats = chats.filter((chat) => chat.mode === "adventure");
  const showGroupSection = enableGroupChats || groupChats.length > 0;
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  const uniqueGroupPersonaIds = Array.from(new Set(groupPersonaIds.filter(Boolean)));
  const uniqueAdventurePersonaIds = Array.from(new Set(adventurePersonaIds.filter(Boolean)));
  const getPersonaFeature = (persona: Persona) => persona.advanced.core.archetype || "Персона";
  const groupPersonaOptions = personas
    .filter((persona) => !uniqueGroupPersonaIds.includes(persona.id))
    .map((persona) => ({
      value: persona.id,
      label: persona.name,
      description: getPersonaFeature(persona),
      avatarSrc: resolveAvatarSrc(persona) || undefined,
    }));
  const adventurePersonaOptions = personas
    .filter((persona) => !uniqueAdventurePersonaIds.includes(persona.id))
    .map((persona) => ({
      value: persona.id,
      label: persona.name,
      description: getPersonaFeature(persona),
      avatarSrc: resolveAvatarSrc(persona) || undefined,
    }));

  const addGroupPersona = (personaId: string) => {
    if (!personaId) return;
    setGroupPersonaIds((current) =>
      current.includes(personaId) ? current : [...current, personaId],
    );
    setGroupPersonaPickerValue("");
  };

  const removeGroupPersona = (personaId: string) => {
    if (personaId === activePersonaId) return;
    setGroupPersonaIds((current) => current.filter((id) => id !== personaId));
    setGroupPersonaPickerValue("");
  };

  const addAdventurePersona = (personaId: string) => {
    if (!personaId) return;
    setAdventurePersonaIds((current) =>
      current.includes(personaId) ? current : [...current, personaId],
    );
    setAdventurePersonaPickerValue("");
  };

  const removeAdventurePersona = (personaId: string) => {
    if (personaId === activePersonaId) return;
    setAdventurePersonaIds((current) => current.filter((id) => id !== personaId));
    setAdventurePersonaPickerValue("");
  };

  const renderSelectedPersonaTag = (personaId: string, onRemove: (id: string) => void) => {
    const persona = personaById.get(personaId);
    if (!persona) return null;
    const isCreator = persona.id === activePersonaId;
    const avatarSrc = resolveAvatarSrc(persona);
    const avatarLetter = persona.name.trim().charAt(0).toUpperCase() || "?";

    return (
      <span key={persona.id} className={`selected-persona-tag ${isCreator ? "locked" : ""}`}>
        <span className="selected-persona-tag-avatar" aria-hidden="true">
          {avatarSrc ? <img src={avatarSrc} alt="" loading="lazy" /> : <span>{avatarLetter}</span>}
        </span>
        <span className="selected-persona-tag-text">
          <strong>{persona.name}{isCreator ? " (основная)" : ""}</strong>
          <small>{getPersonaFeature(persona)}</small>
        </span>
        {!isCreator ? (
          <button
            type="button"
            className="selected-persona-tag-remove"
            onClick={() => onRemove(persona.id)}
            aria-label={`Удалить ${persona.name}`}
          >
            ×
          </button>
        ) : null}
      </span>
    );
  };

  const renderChatItem = (chat: ChatSession) => {
    const chatPersona = personas.find((persona) => persona.id === chat.personaId) ?? null;
    const avatarLetter = (chatPersona?.name || "?").trim().charAt(0).toUpperCase();
    const subtitle =
      chat.mode === "direct"
        ? formatDate(chat.updatedAt)
        : `${chat.mode === "group" ? "Групповой чат" : "Приключение"} • ${formatDate(chat.updatedAt)}`;

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
            {resolveAvatarSrc(chatPersona) ? (
              <img src={resolveAvatarSrc(chatPersona)} alt="" loading="lazy" />
            ) : (
              <span>{avatarLetter}</span>
            )}
          </div>
          <div className="sidebar-item-text">
            <strong>{chat.title}</strong>
            <span>{subtitle}</span>
          </div>
        </div>
      </button>
    );
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
              <button
                type="button"
                onClick={() => {
                  if (!activePersonaId) return;
                  if (!enableGroupChats) {
                    onOpenSettings();
                    return;
                  }
                  setAdventureBuilderOpen(false);
                  setGroupBuilderOpen(true);
                  setGroupTitle("");
                  setGroupPersonaIds([activePersonaId]);
                  setGroupPersonaPickerValue("");
                }}
                disabled={!activePersonaId}
                title={
                  enableGroupChats
                    ? "Создать групповой чат"
                    : "Групповые чаты выключены. Нажмите, чтобы открыть настройки."
                }
              >
                <Users size={16} /> {enableGroupChats ? "Новая группа" : "Включить группы"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!activePersonaId) return;
                  setGroupBuilderOpen(false);
                  setAdventureBuilderOpen(true);
                  setAdventureTitle("");
                  setAdventureStartContext("");
                  setAdventureInitialGoal("");
                  setAdventureNarratorStyle("");
                  setAdventureWorldTone("balanced");
                  setAdventureExplicitnessPolicy("fade_to_black");
                  setAdventurePersonaIds([activePersonaId]);
                  setAdventurePersonaPickerValue("");
                }}
                disabled={!activePersonaId}
              >
                <MessageCircle size={16} /> Новое приключение
              </button>
            </div>
            {!enableGroupChats ? (
              <small className="sidebar-inline-hint">
                Групповые чаты выключены. Включите их в настройках.
              </small>
            ) : null}
            <div className="chat-mode-sections">
              <section className="chat-mode-section">
                <p className="chat-mode-title">Личные чаты</p>
                {directChats.length > 0 ? (
                  directChats.map(renderChatItem)
                ) : (
                  <p className="empty-state chat-mode-empty">Личных чатов пока нет</p>
                )}
              </section>

              {showGroupSection ? (
                <section className="chat-mode-section">
                  <p className="chat-mode-title">Групповые</p>
                  {groupChats.length > 0 ? (
                    groupChats.map(renderChatItem)
                  ) : (
                    <p className="empty-state chat-mode-empty">Групповых чатов пока нет</p>
                  )}
                </section>
              ) : null}

              <section className="chat-mode-section">
                <p className="chat-mode-title">Приключения</p>
                {adventureChats.length > 0 ? (
                  adventureChats.map(renderChatItem)
                ) : (
                  <p className="empty-state chat-mode-empty">Приключений пока нет</p>
                )}
              </section>
            </div>
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

      {groupBuilderOpen ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="group-create-title"
          onClick={() => setGroupBuilderOpen(false)}
        >
          <div className="modal adventure-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="group-create-title">Новая группа</h3>
              <button type="button" onClick={() => setGroupBuilderOpen(false)}>
                <X size={14} /> Закрыть
              </button>
            </div>
            <form
              className="form adventure-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                const uniqueIds = Array.from(new Set(groupPersonaIds.filter(Boolean)));
                if (uniqueIds.length < 2) return;
                onCreateGroupChat(uniqueIds, groupTitle.trim() || undefined);
                setGroupBuilderOpen(false);
              }}
            >
              <label>
                Название группы (опционально)
                <input
                  value={groupTitle}
                  onChange={(event) => setGroupTitle(event.target.value)}
                  placeholder="Например: Вечер у костра"
                />
              </label>
              <label>
                Участники группы
                <Dropdown
                  value={groupPersonaPickerValue}
                  onChange={addGroupPersona}
                  options={groupPersonaOptions}
                  placeholder={
                    groupPersonaOptions.length > 0
                      ? "Добавить персону"
                      : "Все персоны добавлены"
                  }
                  disabled={groupPersonaOptions.length === 0}
                />
              </label>
              <div className="selected-persona-tags">
                {uniqueGroupPersonaIds.map((personaId) =>
                  renderSelectedPersonaTag(personaId, removeGroupPersona),
                )}
              </div>
              <small style={{ color: "var(--text-secondary)" }}>
                Для группы нужно минимум 2 персоны.
              </small>
              <div className="adventure-create-actions">
                <button type="button" onClick={() => setGroupBuilderOpen(false)}>
                  Отмена
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={uniqueGroupPersonaIds.length < 2}
                >
                  Создать группу
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {adventureBuilderOpen ? (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="adventure-create-title"
          onClick={() => setAdventureBuilderOpen(false)}
        >
          <div className="modal adventure-create-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 id="adventure-create-title">Новое приключение</h3>
              <button type="button" onClick={() => setAdventureBuilderOpen(false)}>
                <X size={14} /> Закрыть
              </button>
            </div>
            <form
              className="form adventure-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                const uniqueIds = Array.from(new Set(adventurePersonaIds.filter(Boolean)));
                onCreateAdventureChat(uniqueIds, {
                  title: adventureTitle.trim(),
                  startContext: adventureStartContext.trim(),
                  initialGoal: adventureInitialGoal.trim(),
                  narratorStyle: adventureNarratorStyle.trim(),
                  worldTone: adventureWorldTone,
                  explicitnessPolicy: adventureExplicitnessPolicy,
                });
                setAdventureBuilderOpen(false);
              }}
            >
              <label>
                Название приключения
                <input
                  value={adventureTitle}
                  onChange={(event) => setAdventureTitle(event.target.value)}
                  placeholder="Например: Тайна заброшенного маяка"
                />
              </label>
              <label>
                Стартовый контекст
                <textarea
                  value={adventureStartContext}
                  onChange={(event) => setAdventureStartContext(event.target.value)}
                  rows={4}
                  placeholder="Опишите сцену, место и исходные обстоятельства."
                />
              </label>
              <label>
                Цель сцены
                <input
                  value={adventureInitialGoal}
                  onChange={(event) => setAdventureInitialGoal(event.target.value)}
                  placeholder="Например: Найти пропавший ключ до рассвета"
                />
              </label>
              <label>
                Стиль рассказчика
                <input
                  value={adventureNarratorStyle}
                  onChange={(event) => setAdventureNarratorStyle(event.target.value)}
                  placeholder="Кинематографичный, напряженный, с акцентом на эмоции"
                />
              </label>
              <label>
                Тон мира
                <Dropdown
                  value={adventureWorldTone}
                  onChange={(nextValue) =>
                    setAdventureWorldTone(nextValue as "light" | "balanced" | "dark")
                  }
                  options={ADVENTURE_WORLD_TONE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
              </label>
              <label>
                Политика явности
                <Dropdown
                  value={adventureExplicitnessPolicy}
                  onChange={(nextValue) =>
                    setAdventureExplicitnessPolicy(
                      nextValue as "fade_to_black" | "balanced" | "explicit",
                    )
                  }
                  options={ADVENTURE_EXPLICITNESS_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
              </label>
              <label>
                Участники приключения
                <Dropdown
                  value={adventurePersonaPickerValue}
                  onChange={addAdventurePersona}
                  options={adventurePersonaOptions}
                  placeholder={
                    adventurePersonaOptions.length > 0
                      ? "Добавить персону"
                      : "Все персоны добавлены"
                  }
                  disabled={adventurePersonaOptions.length === 0}
                />
              </label>
              <div className="selected-persona-tags">
                {uniqueAdventurePersonaIds.map((personaId) =>
                  renderSelectedPersonaTag(personaId, removeAdventurePersona),
                )}
              </div>
              <small style={{ color: "var(--text-secondary)" }}>
                Заполните контекст и цель сцены для старта приключения.
              </small>
              <div className="adventure-create-actions">
                <button type="button" onClick={() => setAdventureBuilderOpen(false)}>
                  Отмена
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    adventureStartContext.trim().length === 0 ||
                    adventureInitialGoal.trim().length === 0 ||
                    uniqueAdventurePersonaIds.length < 1
                  }
                >
                  Запустить приключение
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

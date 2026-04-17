import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  SendHorizontal,
  Trash2,
  ChevronDown,
  HeartHandshake,
  Brain,
  Database,
  Zap,
  Link2,
  RotateCw,
} from "lucide-react";
import { getMoodLabel } from "../personaProfiles";
import { dbApi } from "../db";
import type {
  ChatMessage,
  ChatSession,
  ImageGenerationMeta,
  Persona,
  PersonaRuntimeState,
} from "../types";
import type {
  LookEnhancePromptOverrides,
  LookEnhanceTarget,
} from "../ui/types";
import {
  extractRelationshipProposal,
  type PersonaControlPayload,
} from "../personaDynamics";
import { formatShortTime } from "../ui/format";
import { splitAssistantContent } from "../messageContent";
import { resolveSharedEnhancePromptDefaults } from "../features/image-actions/enhancePromptDefaults";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { PersonaProfileModal } from "./PersonaProfileModal";
import { useSmartMessageAutoscroll } from "../ui/useSmartMessageAutoscroll";

interface ChatPaneProps {
  activeChat: ChatSession | null;
  activePersona: Persona | null;
  activeChatId: string | null;
  messages: ChatMessage[];
  imageMetaByUrl: Record<string, ImageGenerationMeta>;
  messageInput: string;
  setMessageInput: (value: string) => void;
  isLoading: boolean;
  activePersonaState: PersonaRuntimeState | null;
  memoryCount: number;
  showSystemImageBlock: boolean;
  showStatusChangeDetails: boolean;
  imageActionBusy: boolean;
  onEnhanceImage: (
    payload: {
      messageId: string;
      sourceUrl: string;
      meta?: ImageGenerationMeta;
    },
    targetOverride?: LookEnhanceTarget,
    promptOverride?: string | LookEnhancePromptOverrides,
  ) => void;
  onRegenerateImage: (
    payload: {
      messageId: string;
      sourceUrl: string;
      meta?: ImageGenerationMeta;
    },
    promptOverride?: string,
  ) => void;
  onDeleteChat: () => void;
  onSubmitMessage: (event: FormEvent) => void;
  onRegeneratePromptAtIndex: (messageId: string, promptIndex: number) => void;
  onResolveRelationshipProposal: (
    messageId: string,
    decision: "accepted" | "rejected",
  ) => void;
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
    const lust = formatDelta("lust", stateDelta.lust);
    const fear = formatDelta("fear", stateDelta.fear);
    const affection = formatDelta("affection", stateDelta.affection);
    const tension = formatDelta("tension", stateDelta.tension);
    if (trust) lines.push(trust);
    if (engagement) lines.push(engagement);
    if (energy) lines.push(energy);
    if (lust) lines.push(lust);
    if (fear) lines.push(fear);
    if (affection) lines.push(affection);
    if (tension) lines.push(tension);
    if (stateDelta.mood) lines.push(`mood: ${stateDelta.mood}`);
    if (stateDelta.relationshipType)
      lines.push(`relationshipType: ${stateDelta.relationshipType}`);
    if (Number.isFinite(stateDelta.relationshipDepth)) {
      const sign =
        stateDelta.relationshipDepth && stateDelta.relationshipDepth > 0
          ? "+"
          : "";
      lines.push(`relationshipDepth: ${sign}${stateDelta.relationshipDepth}`);
    }
    if (stateDelta.relationshipStage)
      lines.push(`relationshipStage: ${stateDelta.relationshipStage}`);
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
      const content = memory.content
        ? `content="${compactText(memory.content, 100)}"`
        : "";
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
  imageMetaByUrl,
  messageInput,
  setMessageInput,
  isLoading,
  activePersonaState,
  memoryCount,
  showSystemImageBlock,
  showStatusChangeDetails,
  imageActionBusy,
  onEnhanceImage,
  onRegenerateImage,
  onDeleteChat,
  onSubmitMessage,
  onRegeneratePromptAtIndex,
  onResolveRelationshipProposal,
  onOpenSidebar,
  onOpenChatDetails,
}: ChatPaneProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<
    ImageGenerationMeta | undefined
  >(undefined);
  const [previewTarget, setPreviewTarget] = useState<{
    messageId: string;
    sourceUrl: string;
    sourceIndex: number;
  } | null>(null);
  const composerWrapperRef = useRef<HTMLDivElement | null>(null);
  const [activePersonaAvatarSrc, setActivePersonaAvatarSrc] = useState("");
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const onRegeneratePromptAtIndexRef = useRef(onRegeneratePromptAtIndex);
  const onResolveRelationshipProposalRef = useRef(
    onResolveRelationshipProposal,
  );
  const messageIds = useMemo(() => messages.map((message) => message.id), [messages]);
  const {
    messagesContainerRef,
    endRef: messagesEndRef,
    unreadCount,
    jumpToLatest,
    onMessagesScroll,
  } = useSmartMessageAutoscroll({
    streamType: "chat",
    streamId: activeChatId,
    messageIds,
    nearBottomThresholdPx: 80,
    overlayRef: composerWrapperRef,
    bottomObscurerSelector: ".mobile-bottom-nav",
    bottomOverlayGapPx: 12,
  });

  onRegeneratePromptAtIndexRef.current = onRegeneratePromptAtIndex;
  onResolveRelationshipProposalRef.current = onResolveRelationshipProposal;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!activePersona) {
        if (!cancelled) setActivePersonaAvatarSrc("");
        return;
      }
      const imageId = activePersona.avatarImageId.trim();
      if (imageId) {
        const asset = await dbApi.getImageAsset(imageId);
        if (cancelled) return;
        if (asset?.dataUrl) {
          setActivePersonaAvatarSrc(asset.dataUrl);
          return;
        }
      }
      const raw = activePersona.avatarUrl.trim();
      if (!cancelled) {
        setActivePersonaAvatarSrc(raw && !raw.startsWith("idb://") ? raw : "");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    activePersona?.id,
    activePersona?.avatarImageId,
    activePersona?.avatarUrl,
  ]);

  useEffect(() => {
    if (!previewTarget || !previewSrc) return;
    const message = messages.find(
      (candidate) => candidate.id === previewTarget.messageId,
    );
    if (!message) return;
    const imageUrls = message.imageUrls ?? [];
    if (imageUrls.length === 0) return;

    const preferredByIndex = imageUrls[previewTarget.sourceIndex] ?? "";
    const preferredBySource = imageUrls.includes(previewTarget.sourceUrl)
      ? previewTarget.sourceUrl
      : "";
    const nextSource =
      preferredByIndex || preferredBySource || imageUrls[0] || previewSrc;

    if (!nextSource || nextSource === previewSrc) {
      return;
    }

    setPreviewSrc(nextSource);
    setPreviewMeta(imageMetaByUrl[nextSource]);
    setPreviewTarget((prev) =>
      prev
        ? {
            ...prev,
            sourceUrl: nextSource,
          }
        : prev,
    );
  }, [messages, imageMetaByUrl, previewTarget, previewSrc]);

  const relationshipBadge = activePersonaState
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
  const previewResolvedMeta = previewTarget
    ? (previewMeta ?? imageMetaByUrl[previewTarget.sourceUrl])
    : previewMeta;
  const previewEnhancePromptDefaults = previewTarget
    ? resolveSharedEnhancePromptDefaults(activePersona, previewResolvedMeta)
    : undefined;
  const renderedMessages = useMemo(
    () =>
      messages.map((msg) => {
        const parsedAssistant =
          msg.role === "assistant"
            ? splitAssistantContent(msg.content)
            : undefined;
        const textToRender = parsedAssistant?.visibleText ?? msg.content;
        const comfyImageDescriptionsToRender =
          msg.role === "assistant" && showSystemImageBlock
            ? (() => {
                const next = [
                  ...(msg.comfyImageDescriptions ?? []),
                  ...(parsedAssistant?.comfyImageDescriptions ?? []),
                  ...(msg.comfyImageDescription
                    ? [msg.comfyImageDescription]
                    : []),
                  ...(parsedAssistant?.comfyImageDescription
                    ? [parsedAssistant.comfyImageDescription]
                    : []),
                ]
                  .map((value) => value.trim())
                  .filter(Boolean);
                return Array.from(new Set(next));
              })()
            : [];
        const comfyPromptsToRender =
          msg.role === "assistant" && showSystemImageBlock
            ? (() => {
                const next = [
                  ...(msg.comfyPrompts ?? []),
                  ...(parsedAssistant?.comfyPrompts ?? []),
                  ...(msg.comfyPrompt ? [msg.comfyPrompt] : []),
                  ...(parsedAssistant?.comfyPrompt
                    ? [parsedAssistant.comfyPrompt]
                    : []),
                ]
                  .map((value) => value.trim())
                  .filter(Boolean);
                return Array.from(new Set(next));
              })()
            : [];
        const personaControlParsed =
          msg.role === "assistant"
            ? (parsePersonaControlRaw(msg.personaControlRaw) ??
              parsedAssistant?.personaControl)
            : undefined;
        const personaControlToRender =
          msg.role === "assistant" && showStatusChangeDetails
            ? personaControlParsed
            : undefined;
        const relationshipProposal =
          msg.role === "assistant"
            ? extractRelationshipProposal(personaControlParsed)
            : undefined;
        const relationshipProposalType =
          msg.relationshipProposalType ?? relationshipProposal?.type;
        const relationshipProposalStage =
          msg.relationshipProposalStage ?? relationshipProposal?.stage;
        const relationshipProposalStatus =
          msg.role === "assistant" &&
          (relationshipProposalType || relationshipProposalStage)
            ? (msg.relationshipProposalStatus ?? "pending")
            : undefined;
        const relationshipProposalSummary = [
          relationshipProposalType ? `Тип: ${relationshipProposalType}` : "",
          relationshipProposalStage ? `Этап: ${relationshipProposalStage}` : "",
        ]
          .filter(Boolean)
          .join(" • ");
        const statusDetails = buildStatusDetails(personaControlToRender);
        const imageUrlsToRender = msg.imageUrls ?? [];
        const fallbackExpected = Math.max(
          1,
          comfyPromptsToRender.length ||
            comfyImageDescriptionsToRender.length ||
            (msg.comfyPrompt ? 1 : 0) ||
            (msg.comfyImageDescription ? 1 : 0),
        );
        const expectedCount = msg.imageGenerationExpected ?? fallbackExpected;
        const completedCount =
          msg.imageGenerationCompleted ?? imageUrlsToRender.length;
        const imageSkeletonCount = Math.max(0, expectedCount - completedCount);

        if (
          !textToRender &&
          comfyImageDescriptionsToRender.length === 0 &&
          comfyPromptsToRender.length === 0 &&
          imageUrlsToRender.length === 0 &&
          !msg.imageGenerationPending &&
          !statusDetails
        ) {
          return null;
        }

        return (
          <article key={msg.id} className={`bubble ${msg.role}`}>
            {textToRender ? <p>{textToRender}</p> : null}
            {comfyImageDescriptionsToRender.map((description, index) => (
              <section
                key={`${msg.id}-img-desc-${index}`}
                className="comfy-prompt-block"
                aria-label="ComfyUI image description"
              >
                <div className="comfy-prompt-head">
                  {comfyImageDescriptionsToRender.length > 1
                    ? `Image description #${index + 1}`
                    : "Image description"}
                </div>
                <pre>{description}</pre>
              </section>
            ))}
            {comfyPromptsToRender.map((prompt, index) => (
              <section
                key={`${msg.id}-comfy-${index}`}
                className="comfy-prompt-block"
                aria-label="ComfyUI prompt"
              >
                <div className="comfy-prompt-head comfy-prompt-head-with-actions">
                  <span>
                    {comfyPromptsToRender.length > 1
                      ? `ComfyUI prompt #${index + 1}`
                      : "ComfyUI prompt"}
                  </span>
                  <button
                    type="button"
                    className="comfy-prompt-regenerate-btn"
                    title="Перегенерировать prompt и изображение"
                    aria-label="Перегенерировать prompt и изображение"
                    disabled={isLoading || imageActionBusy}
                    onClick={() =>
                      onRegeneratePromptAtIndexRef.current(msg.id, index)
                    }
                  >
                    <RotateCw size={14} />
                  </button>
                </div>
                <pre>{prompt}</pre>
              </section>
            ))}
            {imageUrlsToRender.length > 0 ? (
              <section
                className="bubble-images"
                aria-label="Сгенерированные изображения"
              >
                {imageUrlsToRender.map((url, index) => (
                  <button
                    key={`${msg.id}-img-${index}`}
                    type="button"
                    className="bubble-image-btn"
                    onClick={() => {
                      setPreviewSrc(url);
                      const meta = imageMetaByUrl[url];
                      setPreviewMeta(meta);
                      setPreviewTarget({
                        messageId: msg.id,
                        sourceUrl: url,
                        sourceIndex: index,
                      });
                    }}
                  >
                    <img
                      src={url}
                      alt={`generated-${index + 1}`}
                      loading="lazy"
                    />
                  </button>
                ))}
              </section>
            ) : null}
            {msg.imageGenerationPending && imageSkeletonCount > 0 ? (
              <section
                className="bubble-images"
                aria-label="Изображения создаются"
              >
                {Array.from({ length: imageSkeletonCount }).map((_, index) => (
                  <div
                    key={`${msg.id}-skeleton-${index}`}
                    className="image-skeleton-card"
                  />
                ))}
              </section>
            ) : null}
            {statusDetails ? (
              <section
                className="status-change-block"
                aria-label="Изменения статуса"
              >
                <div className="comfy-prompt-head">Изменения статуса</div>
                <pre>{statusDetails}</pre>
              </section>
            ) : null}
            {relationshipProposalStatus ? (
              <section
                className="relationship-proposal-block"
                aria-label="Предложение изменения отношений"
              >
                <div className="comfy-prompt-head">
                  Предложение изменения отношений
                </div>
                <p className="relationship-proposal-summary">
                  {relationshipProposalSummary ||
                    "Предложен новый уровень отношений."}
                </p>
                {relationshipProposalStatus === "pending" ? (
                  <div className="relationship-proposal-actions">
                    <button
                      type="button"
                      className="mini primary"
                      disabled={isLoading}
                      onClick={() =>
                        onResolveRelationshipProposalRef.current(
                          msg.id,
                          "accepted",
                        )
                      }
                    >
                      Принять
                    </button>
                    <button
                      type="button"
                      className="mini"
                      disabled={isLoading}
                      onClick={() =>
                        onResolveRelationshipProposalRef.current(
                          msg.id,
                          "rejected",
                        )
                      }
                    >
                      Отклонить
                    </button>
                  </div>
                ) : (
                  <p
                    className={`relationship-proposal-result ${relationshipProposalStatus}`}
                  >
                    {relationshipProposalStatus === "accepted"
                      ? "Предложение принято."
                      : "Предложение отклонено."}
                  </p>
                )}
              </section>
            ) : null}
            <time>{formatShortTime(msg.createdAt)}</time>
          </article>
        );
      }),
    [
      imageActionBusy,
      imageMetaByUrl,
      isLoading,
      messages,
      showStatusChangeDetails,
      showSystemImageBlock,
    ],
  );

  return (
    <main className="chat">
      <header className="chat-header">
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
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
              <div className="chat-header-persona" onClick={onOpenSidebar} title="Сменить персону">
                <button
                  type="button"
                  className="profile-avatar-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!activePersona) return;
                    setProfileModalOpen(true);
                  }}
                  title={activePersona ? "Открыть профиль персоны" : "Персона не выбрана"}
                  disabled={!activePersona}
                  aria-label={
                    activePersona
                      ? `Открыть профиль персоны ${activePersona.name}`
                      : "Персона не выбрана"
                  }
                >
                  <span className="chat-header-avatar" aria-hidden="true">
                    {activePersonaAvatarSrc ? (
                      <img src={activePersonaAvatarSrc} alt="" loading="lazy" />
                    ) : (
                      <span>
                        {(activePersona?.name || "?")
                          .trim()
                          .charAt(0)
                          .toUpperCase()}
                      </span>
                    )}
                  </span>
                </button>
                {activePersona?.name ?? "Не выбрана"} <ChevronDown size={14} />
              </div>
              {activePersonaState ? (
                <div
                  className="persona-state-badges"
                  aria-label="Состояние персоны"
                >
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
            <button
              className="icon-btn danger"
              type="button"
              onClick={onDeleteChat}
              title="Удалить чат"
            >
              <Trash2 size={16} />
            </button>
          ) : null}
        </div>
      </header>

      <section
        className="messages"
        ref={messagesContainerRef}
        onScroll={onMessagesScroll}
      >
        {renderedMessages}
        {messages.length === 0 ? (
          <p className="empty-state">
            Начните диалог: отправьте первое сообщение.
          </p>
        ) : null}
        <div ref={messagesEndRef} aria-hidden="true" />
      </section>

      <div className="composer-wrapper" ref={composerWrapperRef}>
        {unreadCount > 0 ? (
          <button
            type="button"
            className="new-messages-btn"
            onClick={jumpToLatest}
          >
            Новые: {unreadCount}
          </button>
        ) : null}
        <form className="composer" onSubmit={onSubmitMessage}>
          <textarea
            placeholder="Введите сообщение..."
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmitMessage(e as unknown as FormEvent);
              }
            }}
          />
          <button
            type="submit"
            disabled={!messageInput.trim() || !activePersona || isLoading}
          >
            <SendHorizontal size={20} />
          </button>
        </form>
      </div>
      <ImagePreviewModal
        src={previewSrc}
        meta={previewResolvedMeta}
        enhancePromptDefaults={previewEnhancePromptDefaults}
        actionBusy={imageActionBusy}
        onEnhance={
          previewTarget
            ? (targetOverride, promptOverride) => {
                const effectivePromptOverride =
                  promptOverride ?? previewEnhancePromptDefaults;
                onEnhanceImage(
                  {
                    messageId: previewTarget.messageId,
                    sourceUrl: previewTarget.sourceUrl,
                    meta: previewResolvedMeta,
                  },
                  targetOverride,
                  effectivePromptOverride,
                );
              }
            : undefined
        }
        onRegenerate={
          previewTarget
            ? (promptOverride) => {
                onRegenerateImage(
                  {
                    messageId: previewTarget.messageId,
                    sourceUrl: previewTarget.sourceUrl,
                    meta: previewResolvedMeta,
                  },
                  promptOverride,
                );
              }
            : undefined
        }
        onClose={() => {
          setPreviewSrc(null);
          setPreviewMeta(undefined);
          setPreviewTarget(null);
        }}
      />
      <PersonaProfileModal
        open={profileModalOpen && Boolean(activePersona)}
        persona={activePersona}
        onClose={() => setProfileModalOpen(false)}
      />
    </main>
  );
}

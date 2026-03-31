import { useEffect, useRef, useState, type FormEvent } from "react";
import { Sparkles, Trash2, UserRound, X } from "lucide-react";
import type { GeneratedPersonaDraft } from "../lmstudio";
import { dbApi } from "../db";
import type { ImageGenerationMeta, Persona } from "../types";
import type {
  LookDetailLevel,
  LookEnhanceTarget,
  PersonaDraft,
  PersonaLookPack,
  PersonaModalTab,
} from "../ui/types";
import { Dropdown } from "./Dropdown";
import { ImagePreviewModal } from "./ImagePreviewModal";

interface PersonaModalProps {
  open: boolean;
  personas: Persona[];
  personaModalTab: PersonaModalTab;
  setPersonaModalTab: (value: PersonaModalTab) => void;
  editingPersonaId: string | null;
  personaDraft: PersonaDraft;
  setPersonaDraft: (updater: (prev: PersonaDraft) => PersonaDraft) => void;
  onClose: () => void;
  onEditPersona: (persona: Persona) => void;
  onDeletePersona: (personaId: string) => void;
  onSubmitPersona: (event: FormEvent) => void;
  onResetDraft: () => void;
  generationTheme: string;
  setGenerationTheme: (value: string) => void;
  generationCount: number;
  setGenerationCount: (value: number) => void;
  generationLoading: boolean;
  generatedDrafts: GeneratedPersonaDraft[];
  onSubmitGenerate: (event: FormEvent) => void;
  onSaveGenerated: (draft: GeneratedPersonaDraft) => void;
  onMoveGeneratedToEditor: (draft: GeneratedPersonaDraft) => void;
  lookGenerationLoading: boolean;
  onGeneratePersonaLook: () => void;
  onStopPersonaLookGeneration: () => void;
  lookPackageCount: number;
  setLookPackageCount: (value: number) => void;
  lookDetailLevel: LookDetailLevel;
  setLookDetailLevel: (value: LookDetailLevel) => void;
  lookEnhanceTarget: LookEnhanceTarget;
  setLookEnhanceTarget: (value: LookEnhanceTarget) => void;
  enhancingLookImageKey: string | null;
  onEnhanceLookImage: (
    packIndex: number | null,
    kind: "avatar" | "fullbody" | "side" | "back",
    imageUrl: string,
    targetOverride?: LookEnhanceTarget,
  ) => void;
  onStopLookEnhancement: () => void;
  generatedLookPacks: PersonaLookPack[];
  onApplyLookPack: (pack: PersonaLookPack) => void;
  lookFastMode: boolean;
  setLookFastMode: (value: boolean) => void;
  generateSideView: boolean;
  setGenerateSideView: (value: boolean) => void;
  generateBackView: boolean;
  setGenerateBackView: (value: boolean) => void;
  comfyCheckpoints: string[];
  checkpointsLoading: boolean;
  onRefreshCheckpoints: () => void;
  imageMetaByUrl: Record<string, ImageGenerationMeta>;
}

interface SliderFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
}

const ENHANCE_TARGET_OPTIONS: Array<{ value: LookEnhanceTarget; label: string }> = [
  { value: "all", label: "Все части" },
  { value: "face", label: "Лицо" },
  { value: "eyes", label: "Глаза" },
  { value: "nose", label: "Нос" },
  { value: "lips", label: "Губы" },
  { value: "hands", label: "Руки" },
];

interface EnhanceOverlayButtonProps {
  busy: boolean;
  onEnhance: (targetOverride?: LookEnhanceTarget) => void;
}

function EnhanceOverlayButton({ busy, onEnhance }: EnhanceOverlayButtonProps) {
  const controlRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [touchMode, setTouchMode] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(hover: none), (pointer: coarse)");
    const update = () => setTouchMode(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (busy) setMenuOpen(false);
  }, [busy]);

  return (
    <div
      ref={controlRef}
      className={`persona-look-enhance-control ${busy ? "busy" : ""} ${menuOpen ? "menu-open" : ""}`}
    >
      <button
        type="button"
        className="persona-look-enhance-btn"
        onClick={(event) => {
          event.stopPropagation();
          if (touchMode) {
            setMenuOpen((prev) => !prev);
            return;
          }
          onEnhance();
        }}
        disabled={busy}
        title="Улучшить детали"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <Sparkles size={12} />
        {busy ? "..." : "Улучшить"}
      </button>
      {!busy ? (
        <div className="persona-look-enhance-popover" role="menu" aria-label="Выбор улучшения">
          {ENHANCE_TARGET_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="persona-look-enhance-option"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onEnhance(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SliderField({ label, value, onChange }: SliderFieldProps) {
  return (
    <label className="slider-field">
      <span>
        {label}: <strong>{value}</strong>
      </span>
      <input type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function PersonaModal({
  open,
  personas,
  personaModalTab,
  setPersonaModalTab,
  editingPersonaId,
  personaDraft,
  setPersonaDraft,
  onClose,
  onEditPersona,
  onDeletePersona,
  onSubmitPersona,
  onResetDraft,
  generationTheme,
  setGenerationTheme,
  generationCount,
  setGenerationCount,
  generationLoading,
  generatedDrafts,
  onSubmitGenerate,
  onSaveGenerated,
  onMoveGeneratedToEditor,
  lookGenerationLoading,
  onGeneratePersonaLook,
  onStopPersonaLookGeneration,
  lookPackageCount,
  setLookPackageCount,
  lookDetailLevel,
  setLookDetailLevel,
  lookEnhanceTarget,
  setLookEnhanceTarget,
  enhancingLookImageKey,
  onEnhanceLookImage,
  onStopLookEnhancement,
  generatedLookPacks,
  onApplyLookPack,
  lookFastMode,
  setLookFastMode,
  generateSideView,
  setGenerateSideView,
  generateBackView,
  setGenerateBackView,
  comfyCheckpoints,
  checkpointsLoading,
  onRefreshCheckpoints,
  imageMetaByUrl,
}: PersonaModalProps) {
  const [imageSrcById, setImageSrcById] = useState<Record<string, string>>({});
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMetaOverride, setPreviewMetaOverride] = useState<ImageGenerationMeta | undefined>(undefined);
  const [previewKind, setPreviewKind] = useState<"avatar" | "fullbody" | "side" | "back" | null>(null);

  const parseImageIdFromLink = (value: string) => {
    const normalized = value.trim();
    if (!normalized.startsWith("idb://")) return "";
    return normalized.slice("idb://".length).trim();
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const ids = Array.from(
        new Set(
          [
            personaDraft.avatarImageId,
            personaDraft.fullBodyImageId,
            personaDraft.fullBodySideImageId,
            personaDraft.fullBodyBackImageId,
            ...generatedLookPacks.flatMap((pack) => [
              pack.avatarImageId,
              pack.fullBodyImageId,
              pack.fullBodySideImageId,
              pack.fullBodyBackImageId,
              parseImageIdFromLink(pack.avatarUrl),
              parseImageIdFromLink(pack.fullBodyUrl),
              parseImageIdFromLink(pack.fullBodySideUrl),
              parseImageIdFromLink(pack.fullBodyBackUrl),
            ]),
          ]
            .map((value) => (value ?? "").trim())
            .filter(Boolean),
        ),
      );
      if (ids.length === 0) {
        if (!cancelled) setImageSrcById({});
        return;
      }
      const assets = await dbApi.getImageAssets(ids);
      if (cancelled) return;
      setImageSrcById(Object.fromEntries(assets.map((asset) => [asset.id, asset.dataUrl])));
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    personaDraft.avatarImageId,
    personaDraft.fullBodyImageId,
    personaDraft.fullBodySideImageId,
    personaDraft.fullBodyBackImageId,
    generatedLookPacks,
  ]);

  const resolveImageSrc = (raw: string, imageId?: string) => {
    const normalized = raw.trim();
    if (normalized.startsWith("idb://")) {
      const resolvedImageId = (imageId ?? parseImageIdFromLink(normalized)).trim();
      return imageSrcById[resolvedImageId] ?? "";
    }
    return normalized;
  };

  const draftAvatarSrc = resolveImageSrc(personaDraft.avatarUrl, personaDraft.avatarImageId);
  const draftFullBodySrc = resolveImageSrc(personaDraft.fullBodyUrl, personaDraft.fullBodyImageId);
  const draftSideSrc = resolveImageSrc(personaDraft.fullBodySideUrl, personaDraft.fullBodySideImageId);
  const draftBackSrc = resolveImageSrc(personaDraft.fullBodyBackUrl, personaDraft.fullBodyBackImageId);

  const openPreview = async (
    src: string,
    kind: "avatar" | "fullbody" | "side" | "back",
    imageId?: string,
  ) => {
    const normalizedImageId = (imageId ?? "").trim();
    if (normalizedImageId) {
      const asset = await dbApi.getImageAsset(normalizedImageId);
      if (asset?.dataUrl) {
        setPreviewSrc(asset.dataUrl);
        setPreviewKind(kind);
        setPreviewMetaOverride(asset.meta);
        return;
      }
    }
    setPreviewSrc(src || null);
    setPreviewKind(kind);
    setPreviewMetaOverride(undefined);
  };

  const resolvePreviewMeta = (src: string | null, kind: "avatar" | "fullbody" | "side" | "back" | null) => {
    if (!src) return undefined;
    if (kind) {
      const slotMeta = imageMetaByUrl[`__slot__:${kind}`];
      if (slotMeta) return slotMeta;
    }
    const normalizedSrc = src.trim();
    const direct = imageMetaByUrl[normalizedSrc] ?? imageMetaByUrl[src];
    if (direct) return direct;
    if (normalizedSrc === draftAvatarSrc.trim()) return imageMetaByUrl["__slot__:avatar"];
    if (normalizedSrc === draftFullBodySrc.trim()) return imageMetaByUrl["__slot__:fullbody"];
    if (normalizedSrc === draftSideSrc.trim()) return imageMetaByUrl["__slot__:side"];
    if (normalizedSrc === draftBackSrc.trim()) return imageMetaByUrl["__slot__:back"];
    return undefined;
  };
  const hasAppearance = Object.values(personaDraft.appearance).some((value) => value.trim());
  const describeGeneratedAppearance = (draft: GeneratedPersonaDraft) =>
    [
      draft.appearance.faceDescription,
      draft.appearance.height,
      draft.appearance.eyes,
      draft.appearance.lips,
      draft.appearance.hair,
      draft.appearance.skin,
      draft.appearance.ageType,
      draft.appearance.bodyType,
      draft.appearance.markers,
      draft.appearance.accessories,
      draft.appearance.clothingStyle,
    ]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(", ");

  if (!open) return null;

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="modal large">
        <div className="modal-header">
          <h3>Персоны</h3>
          <button type="button" onClick={onClose}>
            <X size={14} /> Закрыть
          </button>
        </div>

        <div className="modal-tabs">
          <button
            type="button"
            className={personaModalTab === "editor" ? "active" : ""}
            onClick={() => setPersonaModalTab("editor")}
          >
            <UserRound size={14} /> Редактор
          </button>
          <button
            type="button"
            className={personaModalTab === "generator" ? "active" : ""}
            onClick={() => setPersonaModalTab("generator")}
          >
            <Sparkles size={14} /> Генерация личности
          </button>
        </div>

        {personaModalTab === "editor" ? (
          <div className="split">
            <div className="persona-list">
              {personas.map((persona) => (
                <div key={persona.id} className={`persona-item ${persona.id === editingPersonaId ? "active" : ""}`}>
                  <div
                    className="persona-item-content"
                    onClick={() => onEditPersona(persona)}
                    style={{ cursor: "pointer" }}
                  >
                    <strong>{persona.name}</strong>
                    <span>{persona.advanced.core.archetype || persona.personalityPrompt || "Без описания"}</span>
                  </div>
                  <button
                    type="button"
                    className="icon-btn danger mini"
                    onClick={() => onDeletePersona(persona.id)}
                    disabled={personas.length <= 1}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>

            <form className="form" onSubmit={onSubmitPersona}>
              <h4>{editingPersonaId ? "Редактирование" : "Новая персона"}</h4>

              <div className="persona-section">
                <h5>База</h5>
                <input
                  placeholder="Имя"
                  value={personaDraft.name}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, name: event.target.value }))}
                  required
                />
                <textarea
                  placeholder="Legacy промпт характера"
                  value={personaDraft.personalityPrompt}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, personalityPrompt: event.target.value }))}
                />
                <input
                  placeholder="Лицо (общее описание)"
                  value={personaDraft.appearance.faceDescription}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, faceDescription: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Рост"
                  value={personaDraft.appearance.height}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, height: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Глаза"
                  value={personaDraft.appearance.eyes}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, eyes: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Губы"
                  value={personaDraft.appearance.lips}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, lips: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Волосы"
                  value={personaDraft.appearance.hair}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, hair: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Кожа"
                  value={personaDraft.appearance.skin}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, skin: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Возрастной тип"
                  value={personaDraft.appearance.ageType}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, ageType: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Телосложение"
                  value={personaDraft.appearance.bodyType}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, bodyType: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Отличительные маркеры"
                  value={personaDraft.appearance.markers}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, markers: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Аксессуары (опционально)"
                  value={personaDraft.appearance.accessories}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, accessories: event.target.value },
                    }))
                  }
                />
                <input
                  placeholder="Любимый стиль/тип одежды"
                  value={personaDraft.appearance.clothingStyle}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      appearance: { ...prev.appearance, clothingStyle: event.target.value },
                    }))
                  }
                />
                <textarea
                  placeholder="Legacy стиль речи"
                  value={personaDraft.stylePrompt}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, stylePrompt: event.target.value }))}
                />
                <label>
                  Checkpoint для генерации изображений
                  <div className="inline-row">
                    <Dropdown
                      value={personaDraft.imageCheckpoint}
                      onChange={(nextCheckpoint) =>
                        setPersonaDraft((prev) => ({ ...prev, imageCheckpoint: nextCheckpoint }))
                      }
                      options={[
                        { value: "", label: "По умолчанию из workflow" },
                        ...comfyCheckpoints.map((checkpoint) => ({ value: checkpoint, label: checkpoint })),
                      ]}
                    />
                    <button
                      type="button"
                      onClick={onRefreshCheckpoints}
                      disabled={checkpointsLoading}
                    >
                      {checkpointsLoading ? "..." : "Обновить"}
                    </button>
                  </div>
                </label>
                <input
                  placeholder="URL аватара"
                  value={personaDraft.avatarUrl}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, avatarUrl: event.target.value }))}
                />
                <input
                  placeholder="URL fullbody"
                  value={personaDraft.fullBodyUrl}
                  onChange={(event) => setPersonaDraft((prev) => ({ ...prev, fullBodyUrl: event.target.value }))}
                />
                <input
                  placeholder="URL fullbody side"
                  value={personaDraft.fullBodySideUrl}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({ ...prev, fullBodySideUrl: event.target.value }))
                  }
                />
                <input
                  placeholder="URL fullbody back"
                  value={personaDraft.fullBodyBackUrl}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({ ...prev, fullBodyBackUrl: event.target.value }))
                  }
                />
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={generateSideView}
                    onChange={(event) => setGenerateSideView(event.target.checked)}
                  />
                  <span>Генерировать fullbody side (опционально)</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={generateBackView}
                    onChange={(event) => setGenerateBackView(event.target.checked)}
                  />
                  <span>Генерировать fullbody back (опционально)</span>
                </label>
                <label>
                  Количество пакетов для выбора
                  <Dropdown
                    value={String(lookPackageCount)}
                    onChange={(nextCount) => setLookPackageCount(Number(nextCount))}
                    options={[
                      { value: "1", label: "1" },
                      { value: "2", label: "2" },
                      { value: "3", label: "3" },
                      { value: "4", label: "4" },
                    ]}
                  />
                </label>
                <label>
                  Детализация частей изображения
                  <Dropdown
                    value={lookDetailLevel}
                    onChange={(nextLevel) => setLookDetailLevel(nextLevel as LookDetailLevel)}
                    options={[
                      { value: "off", label: "Выкл" },
                      { value: "soft", label: "Мягкая" },
                      { value: "medium", label: "Средняя" },
                      { value: "strong", label: "Сильная" },
                    ]}
                  />
                </label>
                <label>
                  Что улучшать при кнопке "Улучшить"
                  <Dropdown
                    value={lookEnhanceTarget}
                    onChange={(nextTarget) => setLookEnhanceTarget(nextTarget as LookEnhanceTarget)}
                    options={[
                      { value: "all", label: "Все части" },
                      { value: "face", label: "Только лицо" },
                      { value: "eyes", label: "Только глаза" },
                      { value: "nose", label: "Только нос" },
                      { value: "lips", label: "Только губы" },
                      { value: "hands", label: "Только руки" },
                    ]}
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={lookFastMode}
                    onChange={(event) => setLookFastMode(event.target.checked)}
                  />
                  <span>Быстрый режим (оптимизировано для 8GB VRAM)</span>
                </label>
                <div className="inline-row">
                  <button
                    type="button"
                    onClick={onGeneratePersonaLook}
                    disabled={lookGenerationLoading || !hasAppearance}
                  >
                    <Sparkles size={14} />{" "}
                    {lookGenerationLoading ? "Генерирую внешний вид..." : "Сгенерировать внешность"}
                  </button>
                  {lookGenerationLoading ? (
                    <button
                      type="button"
                      className="danger"
                      onClick={onStopPersonaLookGeneration}
                    >
                      Остановить
                    </button>
                  ) : null}
                </div>
                {enhancingLookImageKey ? (
                  <div className="inline-row">
                    <button type="button" className="danger" onClick={onStopLookEnhancement}>
                      Остановить улучшение
                    </button>
                  </div>
                ) : null}
                {personaDraft.avatarUrl ||
                personaDraft.fullBodyUrl ||
                personaDraft.fullBodySideUrl ||
                personaDraft.fullBodyBackUrl ? (
                  <div className="persona-look-grid">
                    {draftAvatarSrc ? (
                      <article className="persona-look-card avatar">
                        <span>Avatar</span>
                        <div className="persona-look-image-wrap">
                          <button
                            type="button"
                            className="persona-look-preview-btn"
                            onClick={() => {
                              void openPreview(draftAvatarSrc, "avatar", personaDraft.avatarImageId);
                            }}
                          >
                            <img src={draftAvatarSrc} alt="persona-avatar" loading="lazy" />
                          </button>
                          <EnhanceOverlayButton
                            busy={enhancingLookImageKey === "draft:avatar"}
                            onEnhance={(targetOverride) =>
                              onEnhanceLookImage(null, "avatar", draftAvatarSrc, targetOverride)
                            }
                          />
                        </div>
                      </article>
                    ) : null}
                    {draftFullBodySrc ? (
                      <article className="persona-look-card fullbody">
                        <span>Fullbody</span>
                        <div className="persona-look-image-wrap">
                          <button
                            type="button"
                            className="persona-look-preview-btn"
                            onClick={() => {
                              void openPreview(draftFullBodySrc, "fullbody", personaDraft.fullBodyImageId);
                            }}
                          >
                            <img src={draftFullBodySrc} alt="persona-fullbody" loading="lazy" />
                          </button>
                          <EnhanceOverlayButton
                            busy={enhancingLookImageKey === "draft:fullbody"}
                            onEnhance={(targetOverride) =>
                              onEnhanceLookImage(null, "fullbody", draftFullBodySrc, targetOverride)
                            }
                          />
                        </div>
                      </article>
                    ) : null}
                    {draftSideSrc ? (
                      <article className="persona-look-card fullbody">
                        <span>Fullbody Side</span>
                        <div className="persona-look-image-wrap">
                          <button
                            type="button"
                            className="persona-look-preview-btn"
                            onClick={() => {
                              void openPreview(draftSideSrc, "side", personaDraft.fullBodySideImageId);
                            }}
                          >
                            <img src={draftSideSrc} alt="persona-fullbody-side" loading="lazy" />
                          </button>
                          <EnhanceOverlayButton
                            busy={enhancingLookImageKey === "draft:side"}
                            onEnhance={(targetOverride) =>
                              onEnhanceLookImage(null, "side", draftSideSrc, targetOverride)
                            }
                          />
                        </div>
                      </article>
                    ) : null}
                    {draftBackSrc ? (
                      <article className="persona-look-card fullbody">
                        <span>Fullbody Back</span>
                        <div className="persona-look-image-wrap">
                          <button
                            type="button"
                            className="persona-look-preview-btn"
                            onClick={() => {
                              void openPreview(draftBackSrc, "back", personaDraft.fullBodyBackImageId);
                            }}
                          >
                            <img src={draftBackSrc} alt="persona-fullbody-back" loading="lazy" />
                          </button>
                          <EnhanceOverlayButton
                            busy={enhancingLookImageKey === "draft:back"}
                            onEnhance={(targetOverride) =>
                              onEnhanceLookImage(null, "back", draftBackSrc, targetOverride)
                            }
                          />
                        </div>
                      </article>
                    ) : null}
                  </div>
                ) : null}
                {generatedLookPacks.length > 0 ? (
                  <div className="generated-list">
                    {generatedLookPacks.map((pack, index) => (
                      <article key={`${pack.fullBodyUrl}-${index}`} className="generated-card">
                        {(() => {
                          const packAvatarSrc = resolveImageSrc(pack.avatarUrl, pack.avatarImageId);
                          const packFullBodySrc = resolveImageSrc(pack.fullBodyUrl, pack.fullBodyImageId);
                          const packSideSrc = resolveImageSrc(pack.fullBodySideUrl, pack.fullBodySideImageId);
                          const packBackSrc = resolveImageSrc(pack.fullBodyBackUrl, pack.fullBodyBackImageId);
                          return (
                            <>
                        <strong>
                          Пакет #{index + 1} {pack.status === "pending" ? "(генерируется...)" : ""}
                        </strong>
                        <div className="persona-look-grid">
                          <article className="persona-look-card avatar">
                            <span>Avatar</span>
                            {packAvatarSrc ? (
                              <div className="persona-look-image-wrap">
                                <button
                                  type="button"
                                  className="persona-look-preview-btn"
                                  onClick={() => {
                                    void openPreview(packAvatarSrc, "avatar", pack.avatarImageId);
                                  }}
                                >
                                  <img src={packAvatarSrc} alt={`look-pack-${index + 1}-avatar`} loading="lazy" />
                                </button>
                                <EnhanceOverlayButton
                                  busy={enhancingLookImageKey === `${index}:avatar`}
                                  onEnhance={(targetOverride) =>
                                    onEnhanceLookImage(index, "avatar", packAvatarSrc, targetOverride)
                                  }
                                />
                              </div>
                            ) : (
                              <div className="image-skeleton-card image-skeleton-fill" />
                            )}
                          </article>
                          <article className="persona-look-card fullbody">
                            <span>Fullbody</span>
                            {packFullBodySrc ? (
                              <div className="persona-look-image-wrap">
                                <button
                                  type="button"
                                  className="persona-look-preview-btn"
                                  onClick={() => {
                                    void openPreview(packFullBodySrc, "fullbody", pack.fullBodyImageId);
                                  }}
                                >
                                  <img src={packFullBodySrc} alt={`look-pack-${index + 1}-fullbody`} loading="lazy" />
                                </button>
                                <EnhanceOverlayButton
                                  busy={enhancingLookImageKey === `${index}:fullbody`}
                                  onEnhance={(targetOverride) =>
                                    onEnhanceLookImage(index, "fullbody", packFullBodySrc, targetOverride)
                                  }
                                />
                              </div>
                            ) : (
                              <div className="image-skeleton-card image-skeleton-fill" />
                            )}
                          </article>
                          {generateSideView ? (
                            <article className="persona-look-card fullbody">
                              <span>Side</span>
                              {packSideSrc ? (
                                <div className="persona-look-image-wrap">
                                  <button
                                    type="button"
                                    className="persona-look-preview-btn"
                                    onClick={() => {
                                      void openPreview(packSideSrc, "side", pack.fullBodySideImageId);
                                    }}
                                  >
                                    <img
                                      src={packSideSrc}
                                      alt={`look-pack-${index + 1}-side`}
                                      loading="lazy"
                                    />
                                  </button>
                                  <EnhanceOverlayButton
                                    busy={enhancingLookImageKey === `${index}:side`}
                                    onEnhance={(targetOverride) =>
                                      onEnhanceLookImage(index, "side", packSideSrc, targetOverride)
                                    }
                                  />
                                </div>
                              ) : (
                                <div className="image-skeleton-card image-skeleton-fill" />
                              )}
                            </article>
                          ) : null}
                          {generateBackView ? (
                            <article className="persona-look-card fullbody">
                              <span>Back</span>
                              {packBackSrc ? (
                                <div className="persona-look-image-wrap">
                                  <button
                                    type="button"
                                    className="persona-look-preview-btn"
                                    onClick={() => {
                                      void openPreview(packBackSrc, "back", pack.fullBodyBackImageId);
                                    }}
                                  >
                                    <img
                                      src={packBackSrc}
                                      alt={`look-pack-${index + 1}-back`}
                                      loading="lazy"
                                    />
                                  </button>
                                  <EnhanceOverlayButton
                                    busy={enhancingLookImageKey === `${index}:back`}
                                    onEnhance={(targetOverride) =>
                                      onEnhanceLookImage(index, "back", packBackSrc, targetOverride)
                                    }
                                  />
                                </div>
                              ) : (
                                <div className="image-skeleton-card image-skeleton-fill" />
                              )}
                            </article>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => onApplyLookPack(pack)}
                          disabled={pack.status !== "ready"}
                        >
                          Применить этот пакет
                        </button>
                            </>
                          );
                        })()}
                      </article>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="persona-section">
                <h5>Core</h5>
                <label>
                  Грамматический род персоны
                  <Dropdown
                    value={personaDraft.advanced.core.selfGender}
                    onChange={(nextGender) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          core: {
                            ...prev.advanced.core,
                            selfGender: nextGender as typeof prev.advanced.core.selfGender,
                          },
                        },
                      }))
                    }
                    options={[
                      { value: "auto", label: "Авто (по имени)" },
                      { value: "female", label: "Женский" },
                      { value: "male", label: "Мужской" },
                      { value: "neutral", label: "Нейтральный (безличные формулировки)" },
                    ]}
                  />
                </label>
                <input
                  placeholder="Архетип"
                  value={personaDraft.advanced.core.archetype}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, archetype: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Предыстория"
                  value={personaDraft.advanced.core.backstory}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, backstory: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Цели"
                  value={personaDraft.advanced.core.goals}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, goals: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Ценности"
                  value={personaDraft.advanced.core.values}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, values: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Границы/табу"
                  value={personaDraft.advanced.core.boundaries}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, boundaries: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Области экспертизы"
                  value={personaDraft.advanced.core.expertise}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        core: { ...prev.advanced.core, expertise: event.target.value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Voice</h5>
                <input
                  placeholder="Тон"
                  value={personaDraft.advanced.voice.tone}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, tone: event.target.value },
                      },
                    }))
                  }
                />
                <input
                  placeholder="Лексика/словарь"
                  value={personaDraft.advanced.voice.lexicalStyle}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, lexicalStyle: event.target.value },
                      },
                    }))
                  }
                />
                <label>
                  Длина фраз
                  <Dropdown
                    value={personaDraft.advanced.voice.sentenceLength}
                    onChange={(nextSentenceLength) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          voice: {
                            ...prev.advanced.voice,
                            sentenceLength:
                              nextSentenceLength as typeof prev.advanced.voice.sentenceLength,
                          },
                        },
                      }))
                    }
                    options={[
                      { value: "short", label: "Короткие" },
                      { value: "balanced", label: "Сбалансированные" },
                      { value: "long", label: "Длинные" },
                    ]}
                  />
                </label>
                <SliderField
                  label="Формальность"
                  value={personaDraft.advanced.voice.formality}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, formality: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Экспрессивность"
                  value={personaDraft.advanced.voice.expressiveness}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, expressiveness: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Эмодзи"
                  value={personaDraft.advanced.voice.emoji}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        voice: { ...prev.advanced.voice, emoji: value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Behavior</h5>
                <SliderField
                  label="Инициативность"
                  value={personaDraft.advanced.behavior.initiative}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, initiative: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Эмпатия"
                  value={personaDraft.advanced.behavior.empathy}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, empathy: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Прямота"
                  value={personaDraft.advanced.behavior.directness}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, directness: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Любопытство"
                  value={personaDraft.advanced.behavior.curiosity}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, curiosity: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Челлендж"
                  value={personaDraft.advanced.behavior.challenge}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, challenge: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Креативность"
                  value={personaDraft.advanced.behavior.creativity}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        behavior: { ...prev.advanced.behavior, creativity: value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Emotion</h5>
                <label>
                  Базовое настроение
                  <Dropdown
                    value={personaDraft.advanced.emotion.baselineMood}
                    onChange={(nextMood) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          emotion: {
                            ...prev.advanced.emotion,
                            baselineMood: nextMood as typeof prev.advanced.emotion.baselineMood,
                          },
                        },
                      }))
                    }
                    options={[
                      { value: "calm", label: "Спокойное" },
                      { value: "warm", label: "Теплое" },
                      { value: "playful", label: "Игривое" },
                      { value: "focused", label: "Сфокусированное" },
                      { value: "analytical", label: "Аналитичное" },
                      { value: "inspired", label: "Вдохновленное" },
                      { value: "annoyed", label: "Раздраженное" },
                      { value: "upset", label: "Расстроенное" },
                      { value: "angry", label: "Злое" },
                    ]}
                  />
                </label>
                <SliderField
                  label="Теплота"
                  value={personaDraft.advanced.emotion.warmth}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, warmth: value },
                      },
                    }))
                  }
                />
                <SliderField
                  label="Стабильность"
                  value={personaDraft.advanced.emotion.stability}
                  onChange={(value) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, stability: value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Позитивные триггеры"
                  value={personaDraft.advanced.emotion.positiveTriggers}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, positiveTriggers: event.target.value },
                      },
                    }))
                  }
                />
                <textarea
                  placeholder="Негативные триггеры"
                  value={personaDraft.advanced.emotion.negativeTriggers}
                  onChange={(event) =>
                    setPersonaDraft((prev) => ({
                      ...prev,
                      advanced: {
                        ...prev.advanced,
                        emotion: { ...prev.advanced.emotion, negativeTriggers: event.target.value },
                      },
                    }))
                  }
                />
              </div>

              <div className="persona-section">
                <h5>Memory</h5>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberFacts}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberFacts: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать факты
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberPreferences}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberPreferences: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать предпочтения
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberGoals}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberGoals: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать цели
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={personaDraft.advanced.memory.rememberEvents}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, rememberEvents: event.target.checked },
                        },
                      }))
                    }
                  />
                  Запоминать события диалога
                </label>
                <label>
                  Лимит памяти
                  <input
                    type="number"
                    min={4}
                    max={120}
                    value={personaDraft.advanced.memory.maxMemories}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, maxMemories: Number(event.target.value) },
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  Срок затухания (дней)
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={personaDraft.advanced.memory.decayDays}
                    onChange={(event) =>
                      setPersonaDraft((prev) => ({
                        ...prev,
                        advanced: {
                          ...prev.advanced,
                          memory: { ...prev.advanced.memory, decayDays: Number(event.target.value) },
                        },
                      }))
                    }
                  />
                </label>
              </div>

              <div className="inline-row">
                <button type="submit" className="primary">
                  {editingPersonaId ? "Сохранить" : "Создать"}
                </button>
                <button type="button" onClick={onResetDraft}>
                  Сбросить
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="form">
            <form onSubmit={onSubmitGenerate} className="generator-form">
              <textarea
                placeholder="Тема генерации: киберпанк, фэнтези, научпоп, дружеский ассистент..."
                value={generationTheme}
                onChange={(event) => setGenerationTheme(event.target.value)}
                rows={4}
              />
              <label>
                Количество
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={generationCount}
                  onChange={(event) => setGenerationCount(Number(event.target.value))}
                />
              </label>
              <button type="submit" disabled={generationLoading}>
                <Sparkles size={14} /> {generationLoading ? "Генерирую..." : "Сгенерировать"}
              </button>
            </form>

            <div className="generated-list">
              {generatedDrafts.map((draft, index) => (
                <article key={`${draft.name}-${index}`} className="generated-card">
                  <h4>{draft.name}</h4>
                  <p>
                    <strong>Характер:</strong> {draft.personalityPrompt}
                  </p>
                  <p>
                    <strong>Внешность:</strong> {describeGeneratedAppearance(draft) || "—"}
                  </p>
                  <p>
                    <strong>Стиль:</strong> {draft.stylePrompt}
                  </p>
                  <p>
                    <strong>Архетип:</strong> {draft.advanced.core.archetype}
                  </p>
                  <p>
                    <strong>Род:</strong> {draft.advanced.core.selfGender}
                  </p>
                  <div className="inline-row">
                    <button type="button" className="primary" onClick={() => onSaveGenerated(draft)}>
                      Сохранить
                    </button>
                    <button type="button" onClick={() => onMoveGeneratedToEditor(draft)}>
                      В редактор
                    </button>
                  </div>
                </article>
              ))}
              {generatedDrafts.length === 0 ? (
                <p className="empty-state">Сгенерированные варианты появятся здесь.</p>
              ) : null}
            </div>
          </div>
        )}
      </div>
      <ImagePreviewModal
        src={previewSrc}
        meta={previewMetaOverride ?? resolvePreviewMeta(previewSrc, previewKind)}
        onClose={() => {
          setPreviewSrc(null);
          setPreviewKind(null);
          setPreviewMetaOverride(undefined);
        }}
      />
    </div>
  );
}

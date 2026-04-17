import { useEffect, useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { dbApi } from "../db";
import {
  createEmptyInfluenceProfile,
  normalizeInfluenceProfile,
  resolveInfluenceCurrentIntent,
} from "../influenceProfile";
import { extractImageAssetIdFromIdbUrl } from "../personaAvatar";
import type { InfluenceProfile, Persona } from "../types";
import { ImagePreviewModal } from "./ImagePreviewModal";

interface PersonaProfileModalProps {
  open: boolean;
  persona: Persona | null;
  influenceProfile?: InfluenceProfile | null;
  currentIntent?: string | null;
  onSaveInfluenceProfile?: (profile: InfluenceProfile) => void;
  onResetInfluenceProfile?: () => void;
  onClose: () => void;
}

type PersonaImageSlot = "avatar" | "fullBody" | "side" | "back";

interface PersonaImageEntry {
  key: PersonaImageSlot;
  label: string;
  imageId: string;
  externalUrl: string;
}

type PersonaProfileTab = "profile" | "behavior";

function resolveExternalUrl(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith("idb://")) return "";
  return normalized;
}

function compactText(value: string, fallback = "—") {
  const normalized = value.trim();
  return normalized || fallback;
}

function toDisplayRows(items: Array<{ label: string; value: string }>) {
  return items
    .map((item) => ({ label: item.label, value: item.value.trim() }))
    .filter((item) => item.value);
}

function labelForSlot(slot: PersonaImageSlot) {
  if (slot === "avatar") return "Avatar";
  if (slot === "fullBody") return "Body";
  if (slot === "side") return "Side";
  return "Back";
}

export function PersonaProfileModal({
  open,
  persona,
  influenceProfile,
  currentIntent,
  onSaveInfluenceProfile,
  onResetInfluenceProfile,
  onClose,
}: PersonaProfileModalProps) {
  const [imageSrcBySlot, setImageSrcBySlot] = useState<
    Record<PersonaImageSlot, string>
  >({
    avatar: "",
    fullBody: "",
    side: "",
    back: "",
  });
  const [selectedImageKey, setSelectedImageKey] =
    useState<PersonaImageSlot>("avatar");
  const [previewImage, setPreviewImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const [influenceDraft, setInfluenceDraft] = useState<InfluenceProfile>(() =>
    createEmptyInfluenceProfile(),
  );
  const [influenceDirty, setInfluenceDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<PersonaProfileTab>("profile");

  const imageEntries = useMemo<PersonaImageEntry[]>(() => {
    if (!persona) return [];
    return [
      {
        key: "avatar",
        label: "Avatar",
        imageId:
          persona.avatarImageId.trim() ||
          extractImageAssetIdFromIdbUrl(persona.avatarUrl),
        externalUrl: resolveExternalUrl(persona.avatarUrl),
      },
      {
        key: "fullBody",
        label: "Body",
        imageId:
          persona.fullBodyImageId.trim() ||
          extractImageAssetIdFromIdbUrl(persona.fullBodyUrl),
        externalUrl: resolveExternalUrl(persona.fullBodyUrl),
      },
      {
        key: "side",
        label: "Side",
        imageId:
          persona.fullBodySideImageId.trim() ||
          extractImageAssetIdFromIdbUrl(persona.fullBodySideUrl),
        externalUrl: resolveExternalUrl(persona.fullBodySideUrl),
      },
      {
        key: "back",
        label: "Back",
        imageId:
          persona.fullBodyBackImageId.trim() ||
          extractImageAssetIdFromIdbUrl(persona.fullBodyBackUrl),
        externalUrl: resolveExternalUrl(persona.fullBodyBackUrl),
      },
    ];
  }, [persona]);

  useEffect(() => {
    if (!open || !persona) {
      setImageSrcBySlot({
        avatar: "",
        fullBody: "",
        side: "",
        back: "",
      });
      setSelectedImageKey("avatar");
      setPreviewImage(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const uniqueIds = Array.from(
        new Set(
          imageEntries
            .map((entry) => entry.imageId.trim())
            .filter(Boolean),
        ),
      );
      const assets =
        uniqueIds.length > 0 ? await dbApi.getImageAssets(uniqueIds) : [];
      if (cancelled) return;

      const dataUrlById = Object.fromEntries(
        assets.map((asset) => [asset.id, asset.dataUrl]),
      );
      const next: Record<PersonaImageSlot, string> = {
        avatar: "",
        fullBody: "",
        side: "",
        back: "",
      };
      for (const entry of imageEntries) {
        next[entry.key] = dataUrlById[entry.imageId] || entry.externalUrl || "";
      }
      setImageSrcBySlot(next);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [imageEntries, open, persona]);

  useEffect(() => {
    if (!open || !persona) {
      setInfluenceDraft(createEmptyInfluenceProfile());
      setInfluenceDirty(false);
      setActiveTab("profile");
      return;
    }
    setInfluenceDraft(
      normalizeInfluenceProfile(
        influenceProfile ?? createEmptyInfluenceProfile(),
        influenceProfile?.updatedAt || new Date().toISOString(),
      ),
    );
    setInfluenceDirty(false);
    setActiveTab("profile");
  }, [influenceProfile, open, persona]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (!open || !persona) return null;
  const canEditInfluence = Boolean(onSaveInfluenceProfile || onResetInfluenceProfile);
  const normalizedDraft = normalizeInfluenceProfile(
    influenceDraft,
    influenceDraft.updatedAt || new Date().toISOString(),
  );
  const derivedIntent =
    currentIntent?.trim() || resolveInfluenceCurrentIntent(normalizedDraft) || "—";
  const sectionMeta = [
    { key: "thoughts" as const, label: "Мысли", addLabel: "Добавить мысль" },
    { key: "desires" as const, label: "Желания", addLabel: "Добавить желание" },
    { key: "goals" as const, label: "Цели", addLabel: "Добавить цель" },
  ];

  const patchInfluenceDraft = (updater: (prev: InfluenceProfile) => InfluenceProfile) => {
    setInfluenceDraft((prev) => ({
      ...updater(prev),
      updatedAt: new Date().toISOString(),
    }));
    setInfluenceDirty(true);
  };

  const avatarSrc = imageSrcBySlot.avatar;
  const personalPhotoEntries = imageEntries
    .filter((entry) => entry.key !== "avatar")
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      src: imageSrcBySlot[entry.key],
    }))
    .filter((entry) => Boolean(entry.src));
  const avatarDisplaySrc = avatarSrc || personalPhotoEntries[0]?.src || "";
  const selectedImageSrc = imageSrcBySlot[selectedImageKey];
  const fallbackImageEntry =
    imageEntries.find((entry) => Boolean(imageSrcBySlot[entry.key])) ?? null;
  const activeImageSrc =
    selectedImageSrc ||
    (fallbackImageEntry ? imageSrcBySlot[fallbackImageEntry.key] : "");

  const profileRows = toDisplayRows([
    { label: "Архетип", value: persona.advanced.core.archetype },
    { label: "Пол", value: persona.advanced.core.selfGender },
    { label: "Возраст", value: persona.appearance.ageType },
    { label: "Тип тела", value: persona.appearance.bodyType },
    { label: "Рост", value: persona.appearance.height },
    { label: "Глаза", value: persona.appearance.eyes },
    { label: "Волосы", value: persona.appearance.hair },
    { label: "Кожа", value: persona.appearance.skin },
    { label: "Губы", value: persona.appearance.lips },
    { label: "Стиль", value: persona.appearance.clothingStyle },
    { label: "Аксессуары", value: persona.appearance.accessories },
    { label: "Приметы", value: persona.appearance.markers },
    { label: "Лицо", value: persona.appearance.faceDescription },
    { label: "Экспертиза", value: persona.advanced.core.expertise },
    { label: "О себе", value: compactText(persona.advanced.core.backstory, "") },
    { label: "Цели", value: compactText(persona.advanced.core.goals, "") },
    { label: "Ценности", value: compactText(persona.advanced.core.values, "") },
    { label: "Границы", value: compactText(persona.advanced.core.boundaries, "") },
    { label: "Тон общения", value: compactText(persona.advanced.voice.tone, "") },
  ]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal large persona-profile-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2>{persona.name}</h2>
            <p className="modal-subtitle">Профиль персоны</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="modal-tabs persona-profile-tabs">
          <button
            type="button"
            className={activeTab === "profile" ? "active" : ""}
            onClick={() => setActiveTab("profile")}
          >
            Профиль
          </button>
          <button
            type="button"
            className={activeTab === "behavior" ? "active" : ""}
            onClick={() => setActiveTab("behavior")}
          >
            Поведение в чате
          </button>
        </div>

        <div className="persona-profile-scroll">
          {activeTab === "profile" ? (
            <>
              <section className="persona-profile-head">
                <div className="persona-profile-avatar-wrap">
                  {avatarDisplaySrc ? (
                    <img
                      src={avatarDisplaySrc}
                      alt={`${persona.name} avatar`}
                      className="persona-profile-avatar"
                      loading="lazy"
                    />
                  ) : (
                    <div className="persona-profile-avatar persona-profile-avatar-fallback">
                      {persona.name.trim().charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="persona-profile-head-text">
                  <h3>{persona.name}</h3>
                  <p>{persona.advanced.core.archetype || "Персона"}</p>
                </div>
              </section>

              <section className="persona-profile-section-card">
                <div className="persona-profile-section-head">
                  <h4>Личные фото</h4>
                  {activeImageSrc ? (
                    <a
                      href={activeImageSrc}
                      target="_blank"
                      rel="noreferrer"
                      className="attachment-link"
                    >
                      Открыть <ExternalLink size={14} />
                    </a>
                  ) : null}
                </div>

                <div className="persona-profile-photo-strip" aria-label="Миниатюры фото">
                  {imageEntries.map((entry) => {
                    const src = imageSrcBySlot[entry.key];
                    const isActive = Boolean(src) && entry.key === selectedImageKey;
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        className={`persona-profile-photo-thumb ${isActive ? "active" : ""}`}
                        disabled={!src}
                        onClick={() => {
                          if (!src) return;
                          setSelectedImageKey(entry.key);
                          setPreviewImage({
                            src,
                            alt: `${persona.name}-${entry.label}`,
                          });
                        }}
                        title={labelForSlot(entry.key)}
                        aria-label={`Показать фото ${labelForSlot(entry.key)}`}
                      >
                        {src ? (
                          <img
                            src={src}
                            alt={`${persona.name}-${entry.label}-thumb`}
                            loading="lazy"
                          />
                        ) : (
                          <span>{labelForSlot(entry.key).charAt(0)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {!activeImageSrc ? (
                  <p className="persona-profile-empty">Фото пока отсутствуют</p>
                ) : null}
              </section>

              <section className="persona-profile-section-card">
                <div className="persona-profile-section-head">
                  <h4>Детали профиля</h4>
                </div>
                {profileRows.length === 0 ? (
                  <p className="persona-profile-empty">Нет данных</p>
                ) : (
                  <dl className="persona-profile-fields">
                    {profileRows.map((row) => (
                      <div key={row.label}>
                        <dt>{row.label}</dt>
                        <dd>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            </>
          ) : (
            <>
              <section className="persona-profile-head persona-profile-head-compact">
                <div className="persona-profile-avatar-wrap">
                  {avatarDisplaySrc ? (
                    <img
                      src={avatarDisplaySrc}
                      alt={`${persona.name} avatar`}
                      className="persona-profile-avatar"
                      loading="lazy"
                    />
                  ) : (
                    <div className="persona-profile-avatar persona-profile-avatar-fallback">
                      {persona.name.trim().charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="persona-profile-head-text">
                  <h3>Поведение: {persona.name}</h3>
                  <p>Настройки реакций персоны в этом чате</p>
                </div>
              </section>

              <section className="persona-profile-section-card persona-influence-card">
                <div className="persona-influence-top">
                  <div>
                    <div className="persona-profile-section-head">
                      <h4>Вектор внушения</h4>
                    </div>
                    <p className="persona-influence-hint">
                      Скрытая механика: персона воспринимает этот вектор как собственные
                      мысли и цели.
                    </p>
                  </div>
                  <label className="profile-toggle-row profile-toggle-row-spread">
                    <input
                      type="checkbox"
                      checked={Boolean(influenceDraft.enabled)}
                      disabled={!canEditInfluence}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        patchInfluenceDraft((prev) => ({
                          ...prev,
                          enabled: checked,
                        }));
                      }}
                    />
                    <span>Активно</span>
                  </label>
                </div>

                <div className="persona-influence-focus">
                  <span>Текущий фокус</span>
                  <strong>{derivedIntent}</strong>
                </div>

                {sectionMeta.map((section) => (
                  <div key={section.key} className="persona-influence-section">
                    <div className="persona-influence-section-head">
                      <h5>{section.label}</h5>
                      <button
                        type="button"
                        className="mini"
                        disabled={!canEditInfluence}
                        onClick={() =>
                          patchInfluenceDraft((prev) => ({
                            ...prev,
                            [section.key]: [
                              ...prev[section.key],
                              {
                                text: "",
                                strength:
                                  section.key === "thoughts"
                                    ? 45
                                    : section.key === "desires"
                                      ? 60
                                      : 70,
                              },
                            ].slice(0, 8),
                          }))
                        }
                      >
                        {section.addLabel}
                      </button>
                    </div>
                    {influenceDraft[section.key].length === 0 ? (
                      <p className="persona-influence-empty">Пока пусто</p>
                    ) : (
                      influenceDraft[section.key].map((entry, index) => (
                        <div key={`${section.key}-${index}`} className="persona-influence-row">
                          <input
                            type="text"
                            value={entry.text}
                            disabled={!canEditInfluence}
                            onChange={(event) => {
                              const nextText = event.currentTarget.value;
                              patchInfluenceDraft((prev) => ({
                                ...prev,
                                [section.key]: prev[section.key].map((item, itemIndex) =>
                                  itemIndex === index
                                    ? { ...item, text: nextText }
                                    : item,
                                ),
                              }));
                            }}
                            placeholder="Текст влияния"
                          />
                          <label className="persona-influence-strength">
                            <span>Сила</span>
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={entry.strength}
                              disabled={!canEditInfluence}
                              onChange={(event) => {
                                const nextStrength = Number(event.currentTarget.value) || 0;
                                patchInfluenceDraft((prev) => ({
                                  ...prev,
                                  [section.key]: prev[section.key].map((item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...item,
                                          strength: Math.max(
                                            0,
                                            Math.min(100, nextStrength),
                                          ),
                                        }
                                      : item,
                                  ),
                                }));
                              }}
                              aria-label={`${section.label} сила`}
                            />
                          </label>
                          <button
                            type="button"
                            className="mini"
                            disabled={!canEditInfluence}
                            onClick={() =>
                              patchInfluenceDraft((prev) => ({
                                ...prev,
                                [section.key]: prev[section.key].filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              }))
                            }
                          >
                            Удалить
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                ))}

                <label className="persona-influence-freeform">
                  <span>Свободная инструкция</span>
                  <textarea
                    value={influenceDraft.freeform}
                    disabled={!canEditInfluence}
                    rows={3}
                    onChange={(event) => {
                      const nextFreeform = event.currentTarget.value;
                      patchInfluenceDraft((prev) => ({
                        ...prev,
                        freeform: nextFreeform,
                      }));
                    }}
                  />
                </label>
                {canEditInfluence ? (
                  <div className="persona-profile-actions">
                    <button
                      type="button"
                      className="mini"
                      disabled={!influenceDirty}
                      onClick={() => {
                        const cleared = createEmptyInfluenceProfile(
                          new Date().toISOString(),
                        );
                        if (onResetInfluenceProfile) {
                          onResetInfluenceProfile();
                        } else if (onSaveInfluenceProfile) {
                          onSaveInfluenceProfile(cleared);
                        }
                        setInfluenceDraft(cleared);
                        setInfluenceDirty(false);
                      }}
                    >
                      Сбросить
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={!onSaveInfluenceProfile || !influenceDirty}
                      onClick={() => {
                        if (!onSaveInfluenceProfile) return;
                        const nextProfile = normalizeInfluenceProfile(
                          influenceDraft,
                          new Date().toISOString(),
                        );
                        onSaveInfluenceProfile(nextProfile);
                        setInfluenceDraft(nextProfile);
                        setInfluenceDirty(false);
                      }}
                    >
                      Сохранить
                    </button>
                  </div>
                ) : null}
              </section>
            </>
          )}
        </div>
      </div>
      <ImagePreviewModal
        src={previewImage?.src ?? null}
        alt={previewImage?.alt}
        showMeta={false}
        onClose={() => setPreviewImage(null)}
      />
    </div>
  );
}

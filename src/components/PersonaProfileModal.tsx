import { useEffect, useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { dbApi } from "../db";
import { extractImageAssetIdFromIdbUrl } from "../personaAvatar";
import type { Persona } from "../types";

interface PersonaProfileModalProps {
  open: boolean;
  persona: Persona | null;
  onClose: () => void;
}

type PersonaImageSlot = "avatar" | "fullBody" | "side" | "back";

interface PersonaImageEntry {
  key: PersonaImageSlot;
  label: string;
  imageId: string;
  externalUrl: string;
}

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

export function PersonaProfileModal({
  open,
  persona,
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

  const coreRows = toDisplayRows([
    { label: "Archetype", value: persona.advanced.core.archetype },
    { label: "Gender", value: persona.advanced.core.selfGender },
    { label: "Expertise", value: persona.advanced.core.expertise },
  ]);
  const appearanceRows = toDisplayRows([
    { label: "Face", value: persona.appearance.faceDescription },
    { label: "Age", value: persona.appearance.ageType },
    { label: "Body", value: persona.appearance.bodyType },
    { label: "Height", value: persona.appearance.height },
    { label: "Eyes", value: persona.appearance.eyes },
    { label: "Hair", value: persona.appearance.hair },
    { label: "Skin", value: persona.appearance.skin },
    { label: "Lips", value: persona.appearance.lips },
    { label: "Accessories", value: persona.appearance.accessories },
    { label: "Style", value: persona.appearance.clothingStyle },
    { label: "Markers", value: persona.appearance.markers },
  ]);

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
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

        <section className="persona-profile-body">
          <div className="persona-profile-images" aria-label="Изображения персоны">
            {imageEntries.map((entry) => {
              const src = imageSrcBySlot[entry.key];
              return (
                <article key={entry.key} className="persona-profile-image-card">
                  <div className="persona-profile-image-head">
                    <strong>{entry.label}</strong>
                    {src ? (
                      <a
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                        className="attachment-link"
                      >
                        Открыть <ExternalLink size={14} />
                      </a>
                    ) : null}
                  </div>
                  <div className="persona-profile-image-frame">
                    {src ? (
                      <img src={src} alt={`${persona.name}-${entry.label}`} loading="lazy" />
                    ) : (
                      <span className="persona-profile-image-empty">Нет изображения</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="persona-profile-sections">
            <section className="status-card persona-profile-section">
              <h4>Core</h4>
              {coreRows.length === 0 ? (
                <p>—</p>
              ) : (
                <dl className="persona-profile-fields">
                  {coreRows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>

            <section className="status-card persona-profile-section">
              <h4>Appearance</h4>
              {appearanceRows.length === 0 ? (
                <p>—</p>
              ) : (
                <dl className="persona-profile-fields">
                  {appearanceRows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>

            <section className="status-card persona-profile-section">
              <h4>Prompts</h4>
              <p>
                <strong>Personality:</strong>{" "}
                {compactText(persona.personalityPrompt)}
              </p>
              <p>
                <strong>Style:</strong> {compactText(persona.stylePrompt)}
              </p>
              <p>
                <strong>Backstory:</strong>{" "}
                {compactText(persona.advanced.core.backstory)}
              </p>
              <p>
                <strong>Goals:</strong> {compactText(persona.advanced.core.goals)}
              </p>
              <p>
                <strong>Values:</strong>{" "}
                {compactText(persona.advanced.core.values)}
              </p>
              <p>
                <strong>Boundaries:</strong>{" "}
                {compactText(persona.advanced.core.boundaries)}
              </p>
            </section>
          </div>
        </section>
      </div>
    </div>
  );
}

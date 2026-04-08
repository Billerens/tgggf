import type { Persona } from "./types";

export function extractImageAssetIdFromIdbUrl(value: string) {
  const normalized = value.trim();
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

export function resolvePersonaAvatarImageId(persona: Persona) {
  const direct = persona.avatarImageId.trim();
  if (direct) return direct;
  return extractImageAssetIdFromIdbUrl(persona.avatarUrl);
}

export function resolvePersonaExternalAvatarUrl(persona: Persona) {
  const raw = persona.avatarUrl.trim();
  if (!raw || raw.startsWith("idb://")) return "";
  return raw;
}

export function resolvePersonaSecondaryLabel(persona: Persona) {
  return (
    persona.advanced.core.archetype ||
    persona.stylePrompt.trim() ||
    "Персона"
  );
}

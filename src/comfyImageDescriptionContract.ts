import type { PersonaAppearanceProfile } from "./types";

export type ComfyImageDescriptionType =
  | "person"
  | "other_person"
  | "no_person"
  | "group";

export type ComfyImageSubjectMode =
  | "persona_self"
  | "other_person"
  | "no_person"
  | "group";

export interface ComfyCompactAppearanceLocks {
  hair: string;
  eyes: string;
  face: string;
  body: string;
  outfit: string;
  markers: string;
}

export interface ComfyPromptParticipantCatalogEntry {
  id: string;
  alias: string;
  isSelf: boolean;
  compactAppearanceLocks: Partial<ComfyCompactAppearanceLocks>;
}

export interface ParsedComfyImageDescriptionContract {
  type: ComfyImageDescriptionType;
  subjectMode: ComfyImageSubjectMode;
  participants: string[];
  participantAliases: Record<string, string>;
  subjectLocks: Record<string, string>;
  participantsLine: string;
  sceneDescription: string;
  normalizedDescription: string;
  includesPersonaSelf: boolean;
}

function toTrimmedString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value).trim();
  }
  return "";
}

function normalizeTypeToken(token: string | undefined): ComfyImageDescriptionType | null {
  const value = toTrimmedString(token).toLowerCase();
  if (!value) return null;
  if (value === "person" || value === "persona_self" || value === "self") {
    return "person";
  }
  if (value === "other_person" || value === "other") {
    return "other_person";
  }
  if (value === "no_person" || value === "none" || value === "landscape") {
    return "no_person";
  }
  if (value === "group" || value === "multi_person") {
    return "group";
  }
  return null;
}

function normalizeSubjectModeToken(token: string | undefined): ComfyImageSubjectMode | null {
  const value = toTrimmedString(token).toLowerCase();
  if (!value) return null;
  if (value === "persona_self" || value === "person" || value === "self") {
    return "persona_self";
  }
  if (value === "other_person" || value === "other") {
    return "other_person";
  }
  if (value === "no_person" || value === "none") {
    return "no_person";
  }
  if (value === "group" || value === "multi_person") {
    return "group";
  }
  return null;
}

function slugifyExternalToken(rawSlug: string): string {
  return rawSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function canonicalizeParticipantToken(rawToken: string): string | null {
  const token = rawToken.trim();
  if (!token) return null;
  const lower = token.toLowerCase();
  if (lower === "none") return "none";
  if (lower === "persona:self") return "persona:self";
  if (lower.startsWith("persona:")) {
    const id = token.slice(token.indexOf(":") + 1).trim();
    if (!id) return null;
    return `persona:${id}`;
  }
  if (lower.startsWith("external:")) {
    const slugRaw = token.slice(token.indexOf(":") + 1);
    const slug = slugifyExternalToken(slugRaw);
    if (!slug) return null;
    return `external:${slug}`;
  }
  return null;
}

function parseFieldLine(raw: string, key: string): string {
  const match = raw.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([^\\n\\r]+)`, "i"));
  return toTrimmedString(match?.[1]);
}

function splitParticipantTokens(raw: string): string[] {
  if (!raw) return [];
  const normalized = raw.replace(/\s+\+\s+/g, ",");
  return normalized
    .split(/[|,;]/g)
    .map((part) => canonicalizeParticipantToken(part))
    .filter((token): token is string => Boolean(token));
}

function parseTokenValuePairs(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return result;

  const strictRegex =
    /(persona:self|persona:[^=|;,]+|external:[^=|;,]+)\s*=\s*([\s\S]*?)(?=\s*(?:\||,)\s*(?:persona:self|persona:[^=|;,]+|external:[^=|;,]+)\s*=|\s*$)/gi;
  let strictMatch: RegExpExecArray | null;
  while ((strictMatch = strictRegex.exec(trimmed)) !== null) {
    const token = canonicalizeParticipantToken(strictMatch[1] ?? "");
    const value = toTrimmedString(strictMatch[2]);
    if (!token || !value) continue;
    result[token] = value;
  }
  if (Object.keys(result).length > 0) {
    return result;
  }

  const fallbackParts = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of fallbackParts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const tokenRaw = part.slice(0, eqIndex);
    const valueRaw = part.slice(eqIndex + 1);
    const token = canonicalizeParticipantToken(tokenRaw);
    const value = toTrimmedString(valueRaw);
    if (!token || !value) continue;
    result[token] = value;
  }
  return result;
}

function uniqueTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function removeContractLines(raw: string): string {
  return raw
    .split(/\r?\n/g)
    .filter((line) => {
      const lower = line.trim().toLowerCase();
      if (!lower) return false;
      return !(
        lower.startsWith("type:") ||
        lower.startsWith("subject_mode:") ||
        lower.startsWith("participants:") ||
        lower.startsWith("participant_aliases:") ||
        lower.startsWith("subject_locks:")
      );
    })
    .join("\n")
    .trim();
}

function formatPairLine(tokens: string[], values: Record<string, string>): string {
  if (tokens.length === 0) return "none";
  return tokens.map((token) => `${token}=${values[token] || "-"}`).join(" | ");
}

function contractError(message: string) {
  return new Error(`comfy_image_description_contract_invalid:${message}`);
}

function ensureTypeModeCompatibility(
  type: ComfyImageDescriptionType,
  subjectMode: ComfyImageSubjectMode,
) {
  const expectedMode: Record<ComfyImageDescriptionType, ComfyImageSubjectMode> = {
    person: "persona_self",
    other_person: "other_person",
    no_person: "no_person",
    group: "group",
  };
  if (subjectMode !== expectedMode[type]) {
    throw contractError(
      `type_subject_mode_mismatch:type=${type};subject_mode=${subjectMode};expected=${expectedMode[type]}`,
    );
  }
}

export function parseComfyImageDescriptionContract(
  rawDescription: string,
): ParsedComfyImageDescriptionContract {
  const description = toTrimmedString(rawDescription);
  if (!description) {
    throw contractError("description_empty");
  }

  const typeRaw = parseFieldLine(description, "type");
  const subjectModeRaw = parseFieldLine(description, "subject_mode");
  const participantsRaw = parseFieldLine(description, "participants");
  const participantAliasesRaw = parseFieldLine(description, "participant_aliases");
  const subjectLocksRaw = parseFieldLine(description, "subject_locks");

  const type = normalizeTypeToken(typeRaw);
  if (!type) {
    throw contractError("type_missing_or_invalid");
  }
  const subjectMode = normalizeSubjectModeToken(subjectModeRaw);
  if (!subjectMode) {
    throw contractError("subject_mode_missing_or_invalid");
  }
  ensureTypeModeCompatibility(type, subjectMode);

  if (!participantsRaw) {
    throw contractError("participants_missing");
  }
  if (!participantAliasesRaw) {
    throw contractError("participant_aliases_missing");
  }
  if (!subjectLocksRaw) {
    throw contractError("subject_locks_missing");
  }

  const participants = uniqueTokens(splitParticipantTokens(participantsRaw));
  const participantAliases = parseTokenValuePairs(participantAliasesRaw);
  const subjectLocks = parseTokenValuePairs(subjectLocksRaw);

  if (type === "no_person") {
    if (participants.length !== 1 || participants[0] !== "none") {
      throw contractError("no_person_requires_participants_none");
    }
    if (participantAliasesRaw.toLowerCase() !== "none") {
      throw contractError("no_person_requires_participant_aliases_none");
    }
    if (subjectLocksRaw.toLowerCase() !== "none") {
      throw contractError("no_person_requires_subject_locks_none");
    }
  } else {
    if (participants.length === 0 || participants.includes("none")) {
      throw contractError("participants_invalid_for_person_scene");
    }
    if (type === "person") {
      if (participants.length !== 1 || participants[0] !== "persona:self") {
        throw contractError("person_requires_exactly_persona_self");
      }
    }
    if (type === "other_person") {
      if (participants.length !== 1 || participants[0] === "persona:self") {
        throw contractError(
          "other_person_requires_single_non_persona_self_participant",
        );
      }
    }
    if (type === "group" && participants.length < 2) {
      throw contractError("group_requires_at_least_two_unique_participants");
    }
    for (const token of participants) {
      const alias = toTrimmedString(participantAliases[token]);
      if (!alias) {
        throw contractError(`participant_aliases_missing_for_${token}`);
      }
      const lock = toTrimmedString(subjectLocks[token]);
      if (!lock) {
        throw contractError(`subject_locks_missing_for_${token}`);
      }
      if (token.startsWith("external:")) {
        const slug = token.slice("external:".length);
        if (!/^[a-z0-9_]+$/.test(slug)) {
          throw contractError(`external_slug_invalid_for_${token}`);
        }
      }
    }
  }

  const sceneDescription = removeContractLines(description);
  if (!sceneDescription) {
    throw contractError("scene_description_missing");
  }

  const canonicalParticipantsLine =
    type === "no_person" ? "none" : participants.join(", ");
  const canonicalParticipantAliasesLine =
    type === "no_person"
      ? "none"
      : formatPairLine(participants, participantAliases);
  const canonicalSubjectLocksLine =
    type === "no_person" ? "none" : formatPairLine(participants, subjectLocks);
  const normalizedDescription = [
    `type: ${type}`,
    `subject_mode: ${subjectMode}`,
    `participants: ${canonicalParticipantsLine}`,
    `participant_aliases: ${canonicalParticipantAliasesLine}`,
    `subject_locks: ${canonicalSubjectLocksLine}`,
    sceneDescription,
  ].join("\n");

  return {
    type,
    subjectMode,
    participants: type === "no_person" ? [] : participants,
    participantAliases,
    subjectLocks,
    participantsLine: canonicalParticipantsLine,
    sceneDescription,
    normalizedDescription,
    includesPersonaSelf: participants.includes("persona:self"),
  };
}

export function isComfyImageDescriptionContractInvalidError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("comfy_image_description_contract_invalid:") ||
    error.message.startsWith("contract_invalid:")
  );
}

export function compactAppearanceLocksFromAppearance(
  appearance: PersonaAppearanceProfile | undefined,
): ComfyCompactAppearanceLocks {
  return {
    hair: toTrimmedString(appearance?.hair),
    eyes: toTrimmedString(appearance?.eyes),
    face: toTrimmedString(appearance?.faceDescription),
    body: toTrimmedString(appearance?.bodyType),
    outfit: toTrimmedString(appearance?.clothingStyle),
    markers: toTrimmedString(appearance?.markers),
  };
}

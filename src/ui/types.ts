import { createDefaultAdvancedProfile } from "../personaProfiles";
import type { Persona } from "../types";

export type PersonaDraft = Omit<Persona, "id" | "createdAt" | "updatedAt">;
export type SidebarTab = "chats" | "personas" | "generation";
export type PersonaModalTab = "editor" | "generator";
export type LookDetailLevel = "off" | "soft" | "medium" | "strong";
export type LookEnhanceTarget =
  | "all"
  | "face"
  | "eyes"
  | "nose"
  | "lips"
  | "hands"
  | "chest"
  | "vagina";
export type LookEnhanceDetailKey =
  | "face"
  | "eyes"
  | "nose"
  | "lips"
  | "hands"
  | "chest"
  | "vagina";
export interface LookEnhancePromptOverrides {
  sourcePrompt?: string;
  detailPrompts?: Partial<Record<LookEnhanceDetailKey, string>>;
}
export interface PersonaLookPack {
  status: "pending" | "ready";
  avatarUrl: string;
  fullBodyUrl: string;
  fullBodySideUrl: string;
  fullBodyBackUrl: string;
  avatarImageId?: string;
  fullBodyImageId?: string;
  fullBodySideImageId?: string;
  fullBodyBackImageId?: string;
}

export function createEmptyPersonaDraft(): PersonaDraft {
  return {
    name: "",
    personalityPrompt: "",
    stylePrompt: "",
    appearance: {
      faceDescription: "",
      height: "",
      eyes: "",
      lips: "",
      hair: "",
      ageType: "",
      bodyType: "",
      markers: "",
      accessories: "",
      clothingStyle: "",
      skin: "",
    },
    imageCheckpoint: "",
    advanced: createDefaultAdvancedProfile(),
    avatarUrl: "",
    fullBodyUrl: "",
    fullBodySideUrl: "",
    fullBodyBackUrl: "",
    avatarImageId: "",
    fullBodyImageId: "",
    fullBodySideImageId: "",
    fullBodyBackImageId: "",
    imageMetaByUrl: {},
    lookPromptCache: undefined,
  };
}

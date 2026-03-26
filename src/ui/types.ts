import { createDefaultAdvancedProfile } from "../personaProfiles";
import type { Persona } from "../types";

export type PersonaDraft = Omit<Persona, "id" | "createdAt" | "updatedAt">;
export type SidebarTab = "chats" | "personas" | "generation";
export type PersonaModalTab = "editor" | "generator";
export interface PersonaLookPack {
  status: "pending" | "ready";
  avatarUrl: string;
  fullBodyUrl: string;
  fullBodySideUrl: string;
  fullBodyBackUrl: string;
}

export function createEmptyPersonaDraft(): PersonaDraft {
  return {
    name: "",
    personalityPrompt: "",
    appearancePrompt: "",
    stylePrompt: "",
    imageCheckpoint: "",
    advanced: createDefaultAdvancedProfile(),
    avatarUrl: "",
    fullBodyUrl: "",
    fullBodySideUrl: "",
    fullBodyBackUrl: "",
  };
}

import { createDefaultAdvancedProfile } from "../personaProfiles";
import type { Persona } from "../types";

export type PersonaDraft = Omit<Persona, "id" | "createdAt" | "updatedAt">;
export type SidebarTab = "chats" | "personas";
export type PersonaModalTab = "editor" | "generator";

export function createEmptyPersonaDraft(): PersonaDraft {
  return {
    name: "",
    personalityPrompt: "",
    appearancePrompt: "",
    stylePrompt: "",
    advanced: createDefaultAdvancedProfile(),
    avatarUrl: "",
  };
}

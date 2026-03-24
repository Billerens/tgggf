import type { Persona } from "../types";

export type PersonaDraft = Omit<Persona, "id" | "createdAt" | "updatedAt">;
export type SidebarTab = "chats" | "personas";
export type PersonaModalTab = "editor" | "generator";

export const emptyPersonaDraft: PersonaDraft = {
  name: "",
  personalityPrompt: "",
  appearancePrompt: "",
  stylePrompt: "",
  avatarUrl: "",
};

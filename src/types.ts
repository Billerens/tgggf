export type ChatRole = "system" | "user" | "assistant";

export interface Persona {
  id: string;
  name: string;
  personalityPrompt: string;
  appearancePrompt: string;
  stylePrompt: string;
  avatarUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSession {
  id: string;
  personaId: string;
  title: string;
  lastResponseId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface AppSettings {
  lmBaseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKey: string;
}

export interface NativeChatResponse {
  model_instance_id: string;
  output: Array<
    | {
        type: "message";
        content: string;
      }
    | {
        type: string;
        content?: string;
      }
  >;
  response_id?: string;
}

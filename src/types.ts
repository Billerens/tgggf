export type ChatRole = "system" | "user" | "assistant";
export type MoodId = "calm" | "warm" | "playful" | "focused" | "analytical" | "inspired";
export type RelationshipStage = "new" | "familiar" | "trusted";
export type PersonaMemoryKind = "fact" | "preference" | "goal" | "event";

export interface PersonaCoreProfile {
  archetype: string;
  backstory: string;
  goals: string;
  values: string;
  boundaries: string;
  expertise: string;
}

export interface PersonaVoiceProfile {
  tone: string;
  lexicalStyle: string;
  sentenceLength: "short" | "balanced" | "long";
  formality: number;
  expressiveness: number;
  emoji: number;
}

export interface PersonaBehaviorProfile {
  initiative: number;
  empathy: number;
  directness: number;
  curiosity: number;
  challenge: number;
  creativity: number;
}

export interface PersonaEmotionProfile {
  baselineMood: MoodId;
  warmth: number;
  stability: number;
  positiveTriggers: string;
  negativeTriggers: string;
}

export interface PersonaMemoryPolicy {
  rememberFacts: boolean;
  rememberPreferences: boolean;
  rememberGoals: boolean;
  rememberEvents: boolean;
  maxMemories: number;
  decayDays: number;
}

export interface PersonaAdvancedProfile {
  core: PersonaCoreProfile;
  voice: PersonaVoiceProfile;
  behavior: PersonaBehaviorProfile;
  emotion: PersonaEmotionProfile;
  memory: PersonaMemoryPolicy;
}

export interface Persona {
  id: string;
  name: string;
  personalityPrompt: string;
  appearancePrompt: string;
  stylePrompt: string;
  advanced: PersonaAdvancedProfile;
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
  comfyPrompt?: string;
  createdAt: string;
}

export interface PersonaRuntimeState {
  chatId: string;
  personaId: string;
  mood: MoodId;
  trust: number;
  energy: number;
  engagement: number;
  relationshipStage: RelationshipStage;
  activeTopics: string[];
  updatedAt: string;
}

export interface PersonaMemory {
  id: string;
  chatId: string;
  personaId: string;
  kind: PersonaMemoryKind;
  content: string;
  salience: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt?: string;
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

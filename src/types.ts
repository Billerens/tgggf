export type ChatRole = "system" | "user" | "assistant";
export type MoodId =
  | "calm"
  | "warm"
  | "playful"
  | "focused"
  | "analytical"
  | "inspired"
  | "annoyed"
  | "upset"
  | "angry";
export type RelationshipStage = "new" | "acquaintance" | "friendly" | "close" | "bonded";
export type RelationshipType = "neutral" | "friendship" | "romantic" | "mentor" | "playful";
export type PersonaMemoryKind = "fact" | "preference" | "goal" | "event";
export type PersonaMemoryLayer = "short_term" | "episodic" | "long_term";
export type UserGender = "unspecified" | "male" | "female" | "nonbinary";
export type PersonaSelfGender = "auto" | "female" | "male" | "neutral";
export type AuthMode = "none" | "bearer" | "token" | "basic" | "custom";

export interface PersonaCoreProfile {
  archetype: string;
  backstory: string;
  goals: string;
  values: string;
  boundaries: string;
  expertise: string;
  selfGender: PersonaSelfGender;
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

export interface PersonaAppearanceProfile {
  faceDescription: string;
  eyes: string;
  lips: string;
  hair: string;
  ageType: string;
  bodyType: string;
  markers: string;
  accessories: string;
  clothingStyle: string;
  skin: string;
}

export interface Persona {
  id: string;
  name: string;
  personalityPrompt: string;
  stylePrompt: string;
  appearance: PersonaAppearanceProfile;
  imageCheckpoint: string;
  advanced: PersonaAdvancedProfile;
  avatarUrl: string;
  fullBodyUrl: string;
  fullBodySideUrl: string;
  fullBodyBackUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSession {
  id: string;
  personaId: string;
  title: string;
  lastResponseId?: string;
  chatStyleStrength?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatRole;
  content: string;
  comfyPrompt?: string;
  comfyPrompts?: string[];
  imageUrls?: string[];
  imageGenerationPending?: boolean;
  imageGenerationExpected?: number;
  imageGenerationCompleted?: number;
  personaControlRaw?: string;
  createdAt: string;
}

export interface GeneratorImageEntry {
  id: string;
  iteration: number;
  prompt: string;
  imageUrls: string[];
  createdAt: string;
}

export interface GeneratorSession {
  id: string;
  personaId: string;
  topic: string;
  isInfinite: boolean;
  requestedCount: number | null;
  delaySeconds: number;
  status: "running" | "stopped" | "completed" | "error";
  completedCount: number;
  entries: GeneratorImageEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface PersonaRuntimeState {
  chatId: string;
  personaId: string;
  mood: MoodId;
  trust: number;
  energy: number;
  engagement: number;
  relationshipType: RelationshipType;
  relationshipDepth: number;
  relationshipStage: RelationshipStage;
  activeTopics: string[];
  updatedAt: string;
}

export interface PersonaMemory {
  id: string;
  chatId: string;
  personaId: string;
  layer: PersonaMemoryLayer;
  kind: PersonaMemoryKind;
  content: string;
  salience: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt?: string;
}

export interface AppSettings {
  lmBaseUrl: string;
  comfyBaseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  chatStyleStrength: number;
  apiKey: string;
  lmAuth: EndpointAuthConfig;
  comfyAuth: EndpointAuthConfig;
  userGender: UserGender;
  showSystemImageBlock: boolean;
  showStatusChangeDetails: boolean;
}

export interface EndpointAuthConfig {
  mode: AuthMode;
  token: string;
  username: string;
  password: string;
  headerName: string;
  headerPrefix: string;
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

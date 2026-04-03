export type ChatRole = "system" | "user" | "assistant";
export type GroupRoomMode = "personas_only" | "personas_plus_user";
export type GroupRoomStatus = "active" | "paused" | "archived";
export type GroupRoomRuntimePhase =
  | "idle"
  | "orchestrating"
  | "generating"
  | "committing"
  | "waiting_user"
  | "paused"
  | "error";
export type GroupMessageAuthorType = "persona" | "user" | "system" | "orchestrator";
export type GroupParticipantRole = "member" | "moderator" | "observer";
export type GroupMentionTargetType = "persona" | "user" | "group";
export type GroupEventType =
  | "room_created"
  | "room_mode_changed"
  | "participant_added"
  | "participant_removed"
  | "user_injected"
  | "orchestrator_tick_started"
  | "speaker_selected"
  | "persona_spoke"
  | "message_image_requested"
  | "message_image_generated"
  | "mention_resolved"
  | "relation_changed"
  | "memory_shared_written"
  | "memory_private_written"
  | "room_waiting_user"
  | "room_resumed"
  | "room_paused"
  | "orchestrator_invariant_blocked"
  | "snapshot_written";
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
export type GroupMemoryKind =
  | "fact"
  | "preference"
  | "goal"
  | "event"
  | "rule"
  | "decision";
export type GroupMemoryLayer = "short_term" | "episodic" | "long_term";
export type UserGender = "unspecified" | "male" | "female" | "nonbinary";
export type PersonaSelfGender = "auto" | "female" | "male" | "neutral";
export type AuthMode = "none" | "bearer" | "token" | "basic" | "custom";
export type EnhanceDetailLevel = "soft" | "medium" | "strong";

export interface EnhanceDetailLevelConfig {
  i2iBase: number;
  i2iHires: number;
  face: number;
  eyes: number;
  nose: number;
  lips: number;
  hands: number;
  chest: number;
  vagina: number;
}

export type EnhanceDetailStrengthTable = Record<
  EnhanceDetailLevel,
  EnhanceDetailLevelConfig
>;

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
  height: string;
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

export interface PersonaLookDetailPromptCache {
  face: string;
  eyes: string;
  nose: string;
  lips: string;
  hands: string;
  chest?: string;
  vagina?: string;
}

export interface PersonaLookPromptCache {
  fingerprint: number;
  locked?: boolean;
  model: string;
  generatedAt: string;
  avatarPrompt: string;
  fullBodyPrompt: string;
  detailPrompts: PersonaLookDetailPromptCache;
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
  avatarImageId: string;
  fullBodyImageId: string;
  fullBodySideImageId: string;
  fullBodyBackImageId: string;
  imageMetaByUrl?: Record<string, ImageGenerationMeta>;
  lookPromptCache?: PersonaLookPromptCache;
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
  comfyImageDescription?: string;
  comfyImageDescriptions?: string[];
  imageUrls?: string[];
  imageGenerationPending?: boolean;
  imageGenerationExpected?: number;
  imageGenerationCompleted?: number;
  imageMetaByUrl?: Record<string, ImageGenerationMeta>;
  personaControlRaw?: string;
  createdAt: string;
}

export interface GroupRoom {
  id: string;
  title: string;
  mode: GroupRoomMode;
  status: GroupRoomStatus;
  state: {
    phase: GroupRoomRuntimePhase;
    updatedAt: string;
    turnId?: string;
    speakerPersonaId?: string;
    reason?: string;
    error?: string;
  };
  waitingForUser: boolean;
  waitingReason?: string;
  lastTickAt?: string;
  lastResponseId?: string;
  orchestratorVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupParticipant {
  id: string;
  roomId: string;
  personaId: string;
  role: GroupParticipantRole;
  initiativeBias: number;
  talkCooldownMs: number;
  muteUntil?: string;
  aliveScore: number;
  joinedAt: string;
  updatedAt: string;
}

export interface GroupMessageMention {
  targetType: GroupMentionTargetType;
  targetId: string;
  label: string;
  start: number;
  end: number;
}

export interface GroupMessageImageAttachment {
  url: string;
  imageId?: string;
  meta?: ImageGenerationMeta;
}

export interface GroupMessage {
  id: string;
  roomId: string;
  turnId: string;
  authorType: GroupMessageAuthorType;
  authorPersonaId?: string;
  authorDisplayName: string;
  authorAvatarUrl?: string;
  content: string;
  mentions?: GroupMessageMention[];
  imageAttachments?: GroupMessageImageAttachment[];
  comfyPrompt?: string;
  comfyPrompts?: string[];
  comfyImageDescription?: string;
  comfyImageDescriptions?: string[];
  imageGenerationPending?: boolean;
  imageGenerationExpected?: number;
  imageGenerationCompleted?: number;
  imageMetaByUrl?: Record<string, ImageGenerationMeta>;
  personaControlRaw?: string;
  createdAt: string;
}

export interface GroupEvent {
  id: string;
  roomId: string;
  turnId?: string;
  type: GroupEventType;
  payload: Record<string, unknown>;
  causationId?: string;
  correlationId?: string;
  createdAt: string;
}

export interface GroupPersonaState {
  id: string;
  roomId: string;
  personaId: string;
  mood: MoodId;
  trustToUser: number;
  energy: number;
  engagement: number;
  initiative: number;
  affectionToUser: number;
  tension: number;
  activeTopics: string[];
  currentIntent?: string;
  aliveScore: number;
  updatedAt: string;
}

export interface GroupRelationEdge {
  id: string;
  roomId: string;
  fromPersonaId: string;
  toPersonaId: string;
  trust: number;
  respect: number;
  affinity: number;
  tension: number;
  influence: number;
  attraction: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemoryShared {
  id: string;
  roomId: string;
  layer: GroupMemoryLayer;
  kind: GroupMemoryKind;
  content: string;
  salience: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt?: string;
}

export interface GroupMemoryPrivate {
  id: string;
  roomId: string;
  personaId: string;
  layer: GroupMemoryLayer;
  kind: GroupMemoryKind;
  content: string;
  salience: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt?: string;
}

export interface GroupSnapshot {
  id: string;
  roomId: string;
  eventCursor?: string;
  revision: number;
  state: Record<string, unknown>;
  createdAt: string;
}

export interface ImageGenerationMeta {
  seed?: number;
  prompt?: string;
  model?: string;
  flow?: "base" | "i2i";
}

export interface ImageAsset {
  id: string;
  dataUrl: string;
  meta?: ImageGenerationMeta;
  createdAt: string;
}

export interface GeneratorImageEntry {
  id: string;
  iteration: number;
  prompt: string;
  imageUrls: string[];
  imageMetaByUrl?: Record<string, ImageGenerationMeta>;
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
  lust: number;
  fear: number;
  affection: number;
  tension: number;
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
  saveComfyOutputs: boolean;
  model: string;
  imagePromptModel: string;
  personaGenerationModel: string;
  temperature: number;
  maxTokens: number;
  chatStyleStrength: number;
  apiKey: string;
  lmAuth: EndpointAuthConfig;
  comfyAuth: EndpointAuthConfig;
  userName: string;
  userGender: UserGender;
  showSystemImageBlock: boolean;
  showStatusChangeDetails: boolean;
  enhanceDetailLevelAll: EnhanceDetailLevel;
  enhanceDetailLevelPart: EnhanceDetailLevel;
  enhanceDetailStrengthTable: EnhanceDetailStrengthTable;
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

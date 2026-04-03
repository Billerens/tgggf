export type ChatRole = "system" | "user" | "assistant";
export type ChatMode = "direct" | "group" | "adventure";
export type ChatRunStatus = "idle" | "busy" | "error";
export type ChatParticipantType = "user" | "persona" | "narrator";
export type ChatMessageType = "text" | "system" | "narration" | "action_result";
export type ChatAttachmentType = "image";
export type ChatAttachmentVisibility = "all" | "targeted";
export type AdventureExplicitnessPolicy =
  | "fade_to_black"
  | "balanced"
  | "explicit";
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
  mode: ChatMode;
  status: ChatRunStatus;
  activeTurnId?: string;
  scenarioId?: string;
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
  messageType?: ChatMessageType;
  authorParticipantId?: string;
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
  attachments?: ChatAttachment[];
  turnId?: string;
  eventId?: string;
  createdAt: string;
}

export interface ChatAttachment {
  id: string;
  type: ChatAttachmentType;
  imageAssetId?: string;
  caption?: string;
  targetParticipantIds?: string[];
  visibility: ChatAttachmentVisibility;
  createdAt: string;
}

export interface ChatParticipant {
  id: string;
  chatId: string;
  participantType: ChatParticipantType;
  participantRefId: string;
  displayName: string;
  order: number;
  isActive: boolean;
  joinedAt: string;
  updatedAt: string;
}

export type ChatEventType =
  | "turn_started"
  | "speaker_selected"
  | "arbiter_decision"
  | "message_created"
  | "image_requested"
  | "image_created"
  | "turn_committed"
  | "turn_failed"
  | "support_offered"
  | "boundary_crossed"
  | "public_humiliation"
  | "betrayal_hint"
  | "apology_attempted"
  | "apology_rejected"
  | "trust_repair_step"
  | "reconciliation_moment"
  | "emotional_withdrawal"
  | "status_challenge"
  | "romantic_signal"
  | "romantic_rejection"
  | "relationship_commitment"
  | "relationship_breakup"
  | "cooling_off_period";

export interface ChatEvent {
  id: string;
  chatId: string;
  turnId: string;
  eventType: ChatEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type TurnJobStage =
  | "turn_start"
  | "planning"
  | "decision"
  | "actor_response"
  | "image_action"
  | "commit"
  | "finalize";

export type TurnJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TurnJob {
  id: string;
  chatId: string;
  turnId: string;
  mode: ChatMode;
  stage: TurnJobStage;
  payload: Record<string, unknown>;
  status: TurnJobStatus;
  retryCount: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type RelationshipBondState =
  | "neutral"
  | "interest"
  | "romance"
  | "partnership"
  | "estranged"
  | "hostile";

export type RelationshipRomanticIntent =
  | "none"
  | "curious"
  | "attracted"
  | "attached"
  | "obsessed";

export type RelationshipConsentAlignment =
  | "unknown"
  | "mutual"
  | "one_sided"
  | "withdrawn";

export interface RelationshipEdge {
  id: string;
  chatId: string;
  fromPersonaId: string;
  toPersonaId: string;
  bondState: RelationshipBondState;
  romanticIntent: RelationshipRomanticIntent;
  consentAlignment: RelationshipConsentAlignment;
  trust: number;
  safety: number;
  respect: number;
  affection: number;
  attraction: number;
  admiration: number;
  gratitude: number;
  dependency: number;
  jealousy: number;
  envy: number;
  irritation: number;
  contempt: number;
  aversion: number;
  fear: number;
  tension: number;
  intimacy: number;
  distancePreference: number;
  conflictHistoryScore: number;
  repairReadiness: number;
  lastSignificantEventId?: string;
  lastBondShiftAt?: string;
  updatedAt: string;
}

export interface AdventureScenario {
  id: string;
  title: string;
  startContext: string;
  initialGoal: string;
  narratorStyle: string;
  worldTone: "light" | "balanced" | "dark";
  explicitnessPolicy: AdventureExplicitnessPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface AdventureState {
  id: string;
  chatId: string;
  scenarioId: string;
  currentScene: string;
  sceneObjective: string;
  openThreads: string[];
  resolvedThreads: string[];
  timelineSummary: string;
  updatedAt: string;
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
  userGender: UserGender;
  showSystemImageBlock: boolean;
  showStatusChangeDetails: boolean;
  enableGroupChats: boolean;
  enableAdventureMode: boolean;
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

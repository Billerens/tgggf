import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  generateComfyImages,
  readComfyImageGenerationMeta,
  type ComfyImageGenerationMeta,
} from "../../comfy";
import { dbApi } from "../../db";
import { localizeImageUrls } from "../../imageStorage";
import { generateThemedComfyPrompts } from "../../lmstudio";
import { useAppStore } from "../../store";
import type { AppSettings, GeneratorSession, Persona } from "../../types";
import { waitMs, stableSeedFromText } from "../look/lookHelpers";

interface UseTopicGeneratorParams {
  isAndroidRuntime: boolean;
  settings: AppSettings;
  personas: Persona[];
  generationPersonaId: string;
  generationTopic: string;
  generationPromptMode: GeneratorSession["promptMode"];
  generationDirectPromptSeed: number | null;
  generationInfinite: boolean;
  generationCountLimit: number;
  generationDelaySeconds: number;
  generationSessionId: string;
  generationSessions: GeneratorSession[];
  generationSession: GeneratorSession | null;
  generationRunRef: MutableRefObject<number>;
  setGenerationIsRunning: Dispatch<SetStateAction<boolean>>;
  setGenerationPendingImageCount: Dispatch<SetStateAction<number>>;
  setGenerationSessions: Dispatch<SetStateAction<GeneratorSession[]>>;
  setGenerationSessionId: Dispatch<SetStateAction<string>>;
  setGenerationCompletedCount: Dispatch<SetStateAction<number>>;
}

export type TopicGenerationStepResult =
  | "idle"
  | "progress"
  | "completed"
  | "stopped";

const COMFY_SEED_MAX = 1_125_899_906_842_624;
const THEMED_PROMPT_BATCH_SIZE = 8;
const THEMED_PROMPT_REFILL_THRESHOLD = 1;

function normalizeDirectPromptSeed(seed: number | null) {
  if (typeof seed !== "number" || !Number.isFinite(seed)) return null;
  if (seed <= 0) return null;
  return Math.max(1, Math.min(COMFY_SEED_MAX, Math.floor(seed)));
}

function randomComfySeed() {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.getRandomValues) {
    const values = new Uint32Array(2);
    cryptoObject.getRandomValues(values);
    const random64 = (BigInt(values[0]) << 32n) | BigInt(values[1]);
    const bounded = (random64 % BigInt(COMFY_SEED_MAX)) + 1n;
    return Number(bounded);
  }
  return Math.floor(Math.random() * COMFY_SEED_MAX) + 1;
}

function normalizeThemePromptQueue(queue: GeneratorSession["themePromptQueue"]) {
  if (!Array.isArray(queue)) return [] as string[];
  return queue.map((item) => item.trim()).filter(Boolean);
}

interface IterationResult {
  nextSession: GeneratorSession;
}

interface RunContext {
  session: GeneratorSession;
  persona: Persona;
  total: number | null;
  delayMs: number;
}

export function useTopicGenerator({
  isAndroidRuntime,
  settings,
  personas,
  generationPersonaId,
  generationTopic,
  generationPromptMode,
  generationDirectPromptSeed,
  generationInfinite,
  generationCountLimit,
  generationDelaySeconds,
  generationSessionId,
  generationSessions,
  generationSession,
  generationRunRef,
  setGenerationIsRunning,
  setGenerationPendingImageCount,
  setGenerationSessions,
  setGenerationSessionId,
  setGenerationCompletedCount,
}: UseTopicGeneratorParams) {
  const persistSession = useCallback(
    async (nextSession: GeneratorSession) => {
      await dbApi.saveGeneratorSession(nextSession);
      setGenerationSessions((prev) =>
        prev.map((session) =>
          session.id === nextSession.id ? nextSession : session,
        ),
      );
      return nextSession;
    },
    [setGenerationSessions],
  );

  const markSessionAsError = useCallback(
    async (session: GeneratorSession, message: string) => {
      const erroredSession: GeneratorSession = {
        ...session,
        status: "error",
        singleRunRequested: false,
        updatedAt: new Date().toISOString(),
      };
      await persistSession(erroredSession);
      setGenerationIsRunning(false);
      return message;
    },
    [persistSession, setGenerationIsRunning],
  );

  const prepareRunContext = useCallback(
    async (singleRunRequested: boolean): Promise<RunContext | null> => {
      if (!generationPersonaId) {
        useAppStore.setState({ error: "Выберите персону для генерации." });
        return null;
      }
      if (!generationTopic.trim()) {
        useAppStore.setState({
          error:
            generationPromptMode === "direct_prompt"
              ? "Укажите direct prompt для генерации."
              : "Укажите тематику генерации.",
        });
        return null;
      }
      if (!generationSessionId) {
        useAppStore.setState({
          error: "Создайте сессию генератора в меню слева.",
        });
        return null;
      }

      const persona = personas.find((item) => item.id === generationPersonaId);
      if (!persona) {
        useAppStore.setState({ error: "Выбранная персона не найдена." });
        return null;
      }

      const selected = generationSessions.find(
        (candidate) => candidate.id === generationSessionId,
      );
      if (!selected) {
        useAppStore.setState({ error: "Активная сессия генератора не найдена." });
        return null;
      }

      const total = generationInfinite
        ? null
        : Math.max(1, Math.floor(generationCountLimit));
      const delayMs = Math.max(0, Math.floor(generationDelaySeconds * 1000));
      const directPromptSeed = normalizeDirectPromptSeed(generationDirectPromptSeed);
      const now = new Date().toISOString();

      const session: GeneratorSession = {
        ...selected,
        topic: generationTopic.trim(),
        promptMode: generationPromptMode,
        directPromptSeed,
        directPromptSeedArmed:
          generationPromptMode === "direct_prompt" && directPromptSeed !== null,
        singleRunRequested,
        themePromptQueue: [],
        isInfinite: generationInfinite,
        requestedCount: total,
        delaySeconds: generationDelaySeconds,
        status: "running",
        updatedAt: now,
      };

      await persistSession(session);
      setGenerationSessionId(session.id);
      setGenerationCompletedCount(session.completedCount);
      setGenerationPendingImageCount(0);
      return {
        session,
        persona,
        total,
        delayMs,
      };
    },
    [
      generationCountLimit,
      generationDelaySeconds,
      generationDirectPromptSeed,
      generationInfinite,
      generationPersonaId,
      generationPromptMode,
      generationSessionId,
      generationSessions,
      generationTopic,
      persistSession,
      personas,
      setGenerationCompletedCount,
      setGenerationPendingImageCount,
      setGenerationSessionId,
    ],
  );

  const runSingleIteration = useCallback(
    async (params: {
      session: GeneratorSession;
      persona: Persona;
      total: number | null;
      forceStopAfterIteration: boolean;
    }): Promise<IterationResult> => {
      const { session, persona, total, forceStopAfterIteration } = params;
      const topic = session.topic.trim();
      if (!topic) {
        throw new Error(
          session.promptMode === "direct_prompt"
            ? "Укажите direct prompt для генерации."
            : "Укажите тематику генерации.",
        );
      }

      const iteration = session.completedCount + 1;
      const promptMode =
        session.promptMode === "direct_prompt"
          ? "direct_prompt"
          : "theme_llm";
      let prompt = topic;
      let themedPromptQueue = normalizeThemePromptQueue(session.themePromptQueue);
      if (promptMode === "theme_llm") {
        const remainingIterations =
          total === null ? null : Math.max(1, total - session.completedCount);
        const refillTargetSize = forceStopAfterIteration
          ? 1
          : THEMED_PROMPT_BATCH_SIZE;
        let refillError: Error | null = null;
        if (themedPromptQueue.length <= THEMED_PROMPT_REFILL_THRESHOLD) {
          const desiredQueueSize =
            remainingIterations === null
              ? refillTargetSize
              : Math.min(refillTargetSize, remainingIterations);
          const refillCount = Math.max(0, desiredQueueSize - themedPromptQueue.length);
          if (refillCount > 0) {
            try {
              const generatedPrompts = await generateThemedComfyPrompts(
                settings,
                persona,
                topic,
                iteration,
                refillCount,
              );
              themedPromptQueue = [...themedPromptQueue, ...generatedPrompts];
            } catch (error) {
              refillError =
                error instanceof Error
                  ? error
                  : new Error("Ошибка генерации themed prompt batch.");
            }
          }
        }
        if (themedPromptQueue.length === 0) {
          if (refillError) throw refillError;
          throw new Error("Модель вернула пустой comfy prompt.");
        }
        prompt = themedPromptQueue[0];
        themedPromptQueue = themedPromptQueue.slice(1);
      } else {
        themedPromptQueue = [];
      }

      const normalizedDirectSeed = normalizeDirectPromptSeed(session.directPromptSeed);
      const shouldConsumeOneShotSeed =
        promptMode === "direct_prompt" &&
        Boolean(session.directPromptSeedArmed) &&
        normalizedDirectSeed !== null;
      const seed =
        promptMode === "direct_prompt"
          ? shouldConsumeOneShotSeed
            ? normalizedDirectSeed
            : randomComfySeed()
          : stableSeedFromText(`${session.id}:${iteration}:${topic}`);

      setGenerationPendingImageCount((prev) => prev + 1);
      let localized: string[] = [];
      let localizedMetaByUrl: Record<string, ComfyImageGenerationMeta> = {};
      try {
        const styleReferenceImage =
          persona.avatarUrl.trim() || persona.fullBodyUrl.trim() || undefined;
        const generationItem = {
          flow: "base" as const,
          prompt,
          checkpointName: persona.imageCheckpoint || undefined,
          seed,
          styleReferenceImage,
          styleStrength: styleReferenceImage
            ? settings.chatStyleStrength
            : undefined,
          compositionStrength: 0,
          saveComfyOutputs: settings.saveComfyOutputs,
        };
        const imageUrls = await generateComfyImages(
          [generationItem],
          settings.comfyBaseUrl,
          settings.comfyAuth,
        );
        const extractedMeta = imageUrls[0]
          ? await readComfyImageGenerationMeta(
              imageUrls[0],
              settings.comfyBaseUrl,
              settings.comfyAuth,
            )
          : null;
        localized = await localizeImageUrls(imageUrls);
        const meta: ComfyImageGenerationMeta = {
          prompt: extractedMeta?.prompt ?? generationItem.prompt,
          seed: extractedMeta?.seed ?? generationItem.seed,
          model: extractedMeta?.model ?? generationItem.checkpointName,
          flow: extractedMeta?.flow ?? generationItem.flow,
        };
        await Promise.all(
          localized.map((url) =>
            dbApi.saveImageAsset({
              id: crypto.randomUUID(),
              dataUrl: url,
              meta,
              createdAt: new Date().toISOString(),
            }),
          ),
        );
        localizedMetaByUrl = Object.fromEntries(
          localized.map((url) => [url, meta]),
        );
      } finally {
        setGenerationPendingImageCount((prev) => Math.max(0, prev - 1));
      }

      const entry = {
        id: crypto.randomUUID(),
        iteration,
        prompt,
        imageUrls: localized,
        imageMetaByUrl: localizedMetaByUrl,
        createdAt: new Date().toISOString(),
      };

      const completedCount = iteration;
      const reachedLimit =
        !forceStopAfterIteration && total !== null && completedCount >= total;
      const nextStatus: GeneratorSession["status"] = reachedLimit
        ? "completed"
        : forceStopAfterIteration
          ? "stopped"
          : "running";
      const nextSession: GeneratorSession = {
        ...session,
        completedCount,
        entries: [...session.entries, entry],
        status: nextStatus,
        singleRunRequested: false,
        themePromptQueue: themedPromptQueue,
        directPromptSeed: shouldConsumeOneShotSeed
          ? null
          : session.directPromptSeed,
        directPromptSeedArmed: shouldConsumeOneShotSeed
          ? false
          : session.directPromptSeedArmed,
        updatedAt: new Date().toISOString(),
      };
      await persistSession(nextSession);
      setGenerationCompletedCount(completedCount);
      return { nextSession };
    },
    [
      persistSession,
      setGenerationCompletedCount,
      setGenerationPendingImageCount,
      settings,
    ],
  );

  const stopGeneration = useCallback(() => {
    generationRunRef.current += 1;
    setGenerationIsRunning(false);
    setGenerationPendingImageCount(0);
    if (generationSession) {
      const nextSession: GeneratorSession = {
        ...generationSession,
        status: "stopped",
        singleRunRequested: false,
        updatedAt: new Date().toISOString(),
      };
      void persistSession(nextSession);
    }
  }, [
    generationRunRef,
    generationSession,
    persistSession,
    setGenerationIsRunning,
    setGenerationPendingImageCount,
  ]);

  const runGenerationStep = useCallback(async (): Promise<TopicGenerationStepResult> => {
    if (!generationSession) return "idle";
    if (generationSession.status !== "running") {
      return generationSession.status === "completed" ? "completed" : "stopped";
    }

    const total =
      generationSession.isInfinite
        ? null
        : typeof generationSession.requestedCount === "number" &&
            Number.isFinite(generationSession.requestedCount)
          ? Math.max(1, Math.floor(generationSession.requestedCount))
          : null;
    if (
      !generationSession.singleRunRequested &&
      total !== null &&
      generationSession.completedCount >= total
    ) {
      const completedSession: GeneratorSession = {
        ...generationSession,
        status: "completed",
        singleRunRequested: false,
        updatedAt: new Date().toISOString(),
      };
      await persistSession(completedSession);
      setGenerationIsRunning(false);
      return "completed";
    }

    const persona = personas.find((item) => item.id === generationSession.personaId);
    if (!persona) {
      throw new Error(
        await markSessionAsError(
          generationSession,
          "Персона для активной сессии генерации не найдена.",
        ),
      );
    }

    try {
      const { nextSession } = await runSingleIteration({
        session: generationSession,
        persona,
        total,
        forceStopAfterIteration: Boolean(generationSession.singleRunRequested),
      });
      if (nextSession.status === "completed") {
        setGenerationIsRunning(false);
        return "completed";
      }
      if (nextSession.status === "stopped") {
        setGenerationIsRunning(false);
        return "stopped";
      }
      return "progress";
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Ошибка генерации изображения";
      throw new Error(await markSessionAsError(generationSession, message));
    }
  }, [
    generationSession,
    markSessionAsError,
    persistSession,
    personas,
    runSingleIteration,
    setGenerationIsRunning,
  ]);

  const startGeneration = useCallback(async () => {
    const context = await prepareRunContext(false);
    if (!context) return;

    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    setGenerationIsRunning(true);

    if (isAndroidRuntime) {
      return;
    }

    let mutableSession = context.session;
    try {
      while (
        generationRunRef.current === runId &&
        (context.total === null || mutableSession.completedCount < context.total)
      ) {
        const result = await runSingleIteration({
          session: mutableSession,
          persona: context.persona,
          total: context.total,
          forceStopAfterIteration: false,
        });
        mutableSession = result.nextSession;
        if (mutableSession.status !== "running") break;
        if (generationRunRef.current !== runId) break;
        await waitMs(context.delayMs);
      }

      if (mutableSession.status === "running") {
        mutableSession = {
          ...mutableSession,
          status: generationRunRef.current === runId ? "completed" : "stopped",
          updatedAt: new Date().toISOString(),
        };
        await persistSession(mutableSession);
      }
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Ошибка генерации изображения";
      await markSessionAsError(mutableSession, message);
      useAppStore.setState({ error: message });
    } finally {
      if (generationRunRef.current === runId) {
        setGenerationIsRunning(false);
      }
      setGenerationPendingImageCount(0);
    }
  }, [
    generationRunRef,
    isAndroidRuntime,
    markSessionAsError,
    persistSession,
    prepareRunContext,
    runSingleIteration,
    setGenerationIsRunning,
    setGenerationPendingImageCount,
  ]);

  const startSingleGeneration = useCallback(async () => {
    const context = await prepareRunContext(true);
    if (!context) return;

    const runId = generationRunRef.current + 1;
    generationRunRef.current = runId;
    setGenerationIsRunning(true);

    if (isAndroidRuntime) {
      return;
    }

    try {
      await runSingleIteration({
        session: context.session,
        persona: context.persona,
        total: context.total,
        forceStopAfterIteration: true,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Ошибка генерации изображения";
      await markSessionAsError(context.session, message);
      useAppStore.setState({ error: message });
    } finally {
      if (generationRunRef.current === runId) {
        setGenerationIsRunning(false);
      }
      setGenerationPendingImageCount(0);
    }
  }, [
    generationRunRef,
    isAndroidRuntime,
    markSessionAsError,
    prepareRunContext,
    runSingleIteration,
    setGenerationIsRunning,
    setGenerationPendingImageCount,
  ]);

  return {
    runGenerationStep,
    startGeneration,
    startSingleGeneration,
    stopGeneration,
  };
}

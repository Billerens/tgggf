import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { generateComfyImages, readComfyImageGenerationMeta, type ComfyImageGenerationMeta } from "../../comfy";
import { dbApi } from "../../db";
import { localizeImageUrls } from "../../imageStorage";
import { generateThemedComfyPrompt } from "../../lmstudio";
import { useAppStore } from "../../store";
import type { AppSettings, GeneratorSession, Persona } from "../../types";
import { waitMs, stableSeedFromText } from "../look/lookHelpers";

interface UseTopicGeneratorParams {
  isAndroidRuntime: boolean;
  settings: AppSettings;
  personas: Persona[];
  generationPersonaId: string;
  generationTopic: string;
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

export function useTopicGenerator({
  isAndroidRuntime,
  settings,
  personas,
  generationPersonaId,
  generationTopic,
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
  const stopGeneration = useCallback(() => {
    generationRunRef.current += 1;
    setGenerationIsRunning(false);
    setGenerationPendingImageCount(0);
    if (generationSession) {
      const nextSession: GeneratorSession = {
        ...generationSession,
        status: "stopped",
        updatedAt: new Date().toISOString(),
      };
      void dbApi.saveGeneratorSession(nextSession);
      setGenerationSessions((prev) =>
        prev.map((session) =>
          session.id === nextSession.id ? nextSession : session,
        ),
      );
    }
  }, [
    generationRunRef,
    generationSession,
    setGenerationIsRunning,
    setGenerationPendingImageCount,
    setGenerationSessions,
  ]);

  const runGenerationStep = useCallback(async (): Promise<TopicGenerationStepResult> => {
    if (!generationSession) return "idle";
    if (generationSession.status !== "running") {
      return generationSession.status === "completed" ? "completed" : "stopped";
    }

    const markSessionAsError = async (message: string) => {
      const erroredSession: GeneratorSession = {
        ...generationSession,
        status: "error",
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(erroredSession);
      setGenerationSessions((prev) =>
        prev.map((session) =>
          session.id === erroredSession.id ? erroredSession : session,
        ),
      );
      setGenerationIsRunning(false);
      return message;
    };

    const persona = personas.find((item) => item.id === generationSession.personaId);
    if (!persona) {
      throw new Error(
        await markSessionAsError("Персона для активной сессии генерации не найдена."),
      );
    }

    const topic = generationSession.topic.trim();
    if (!topic) {
      throw new Error(await markSessionAsError("Укажите тематику генерации."));
    }

    const total = generationSession.isInfinite
      ? null
      : typeof generationSession.requestedCount === "number" &&
          Number.isFinite(generationSession.requestedCount)
        ? Math.max(1, Math.floor(generationSession.requestedCount))
        : null;
    if (total !== null && generationSession.completedCount >= total) {
      const completedSession: GeneratorSession = {
        ...generationSession,
        status: "completed",
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(completedSession);
      setGenerationSessions((prev) =>
        prev.map((session) =>
          session.id === completedSession.id ? completedSession : session,
        ),
      );
      setGenerationIsRunning(false);
      return "completed";
    }

    try {
      const iteration = generationSession.completedCount + 1;
      const prompt = await generateThemedComfyPrompt(
        settings,
        persona,
        topic,
        iteration,
      );
      setGenerationPendingImageCount((prev) => prev + 1);
      let localized: string[] = [];
      let localizedMetaByUrl: Record<string, ComfyImageGenerationMeta> = {};
      try {
        const seed = stableSeedFromText(
          `${generationSession.id}:${iteration}:${topic}`,
        );
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
      const nextStatus =
        total !== null && completedCount >= total ? "completed" : "running";
      const nextSession: GeneratorSession = {
        ...generationSession,
        completedCount,
        entries: [...generationSession.entries, entry],
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(nextSession);
      setGenerationCompletedCount(completedCount);
      setGenerationSessions((prev) =>
        prev.map((session) =>
          session.id === nextSession.id ? nextSession : session,
        ),
      );
      if (nextStatus === "completed") {
        setGenerationIsRunning(false);
        return "completed";
      }
      return "progress";
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Ошибка генерации изображения";
      throw new Error(await markSessionAsError(message));
    }
  }, [
    generationSession,
    personas,
    setGenerationCompletedCount,
    setGenerationIsRunning,
    setGenerationPendingImageCount,
    setGenerationSessions,
    settings,
  ]);

  const startGeneration = useCallback(async () => {
    if (!generationPersonaId) {
      useAppStore.setState({ error: "Выберите персону для генерации." });
      return;
    }
    if (!generationTopic.trim()) {
      useAppStore.setState({ error: "Укажите тематику генерации." });
      return;
    }
    if (!generationSessionId) {
      useAppStore.setState({
        error: "Создайте сессию генератора в меню слева.",
      });
      return;
    }

    const total = generationInfinite
      ? null
      : Math.max(1, Math.floor(generationCountLimit));
    const delayMs = Math.max(0, Math.floor(generationDelaySeconds * 1000));
    const runId = generationRunRef.current + 1;
    const persona = personas.find((item) => item.id === generationPersonaId);
    if (!persona) {
      useAppStore.setState({ error: "Выбранная персона не найдена." });
      return;
    }

    const now = new Date().toISOString();
    const selected = generationSessions.find(
      (candidate) => candidate.id === generationSessionId,
    );
    if (!selected) {
      useAppStore.setState({ error: "Активная сессия генератора не найдена." });
      return;
    }
    const session: GeneratorSession = {
      ...selected,
      topic: generationTopic.trim(),
      isInfinite: generationInfinite,
      requestedCount: total,
      delaySeconds: generationDelaySeconds,
      status: "running",
      updatedAt: now,
    };

    await dbApi.saveGeneratorSession(session);
    setGenerationSessions((prev) => {
      return prev.map((candidate) =>
        candidate.id === session.id ? session : candidate,
      );
    });
    setGenerationSessionId(session.id);
    generationRunRef.current = runId;
    setGenerationCompletedCount(session.completedCount);
    setGenerationIsRunning(true);
    setGenerationPendingImageCount(0);

    if (isAndroidRuntime) {
      return;
    }

    let completed = session.completedCount;
    let mutableSession = session;
    try {
      while (
        generationRunRef.current === runId &&
        (total === null || completed < total)
      ) {
        const iteration = completed + 1;
        const prompt = await generateThemedComfyPrompt(
          settings,
          persona,
          generationTopic.trim(),
          iteration,
        );
        setGenerationPendingImageCount((prev) => prev + 1);
        let localized: string[] = [];
        let localizedMetaByUrl: Record<string, ComfyImageGenerationMeta> = {};
        try {
          const seed = stableSeedFromText(
            `${session.id}:${iteration}:${generationTopic}`,
          );
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
        completed = iteration;
        setGenerationCompletedCount(completed);
        mutableSession = {
          ...mutableSession,
          completedCount: completed,
          entries: [...mutableSession.entries, entry],
          updatedAt: new Date().toISOString(),
        };
        await dbApi.saveGeneratorSession(mutableSession);
        setGenerationSessions((prev) =>
          prev.map((candidate) =>
            candidate.id === mutableSession.id ? mutableSession : candidate,
          ),
        );

        if (generationRunRef.current !== runId) break;
        await waitMs(delayMs);
      }
      mutableSession = {
        ...mutableSession,
        status: generationRunRef.current === runId ? "completed" : "stopped",
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(mutableSession);
      setGenerationSessions((prev) =>
        prev.map((candidate) =>
          candidate.id === mutableSession.id ? mutableSession : candidate,
        ),
      );
    } catch (error) {
      mutableSession = {
        ...mutableSession,
        status: "error",
        updatedAt: new Date().toISOString(),
      };
      await dbApi.saveGeneratorSession(mutableSession);
      setGenerationSessions((prev) =>
        prev.map((candidate) =>
          candidate.id === mutableSession.id ? mutableSession : candidate,
        ),
      );
      useAppStore.setState({ error: (error as Error).message });
    } finally {
      if (generationRunRef.current === runId) {
        setGenerationIsRunning(false);
      }
      setGenerationPendingImageCount(0);
    }
  }, [
    generationCountLimit,
    generationDelaySeconds,
    generationInfinite,
    isAndroidRuntime,
    generationPersonaId,
    generationRunRef,
    generationSessionId,
    generationSessions,
    generationTopic,
    personas,
    settings,
    setGenerationCompletedCount,
    setGenerationIsRunning,
    setGenerationPendingImageCount,
    setGenerationSessionId,
    setGenerationSessions,
  ]);

  return {
    runGenerationStep,
    startGeneration,
    stopGeneration,
  };
}

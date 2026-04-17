import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { dbApi } from "../../db";
import { useAppStore } from "../../store";
import type { GeneratorSession, Persona } from "../../types";
import type { SidebarTab } from "../../ui/types";

interface UseGenerationSessionManagerParams {
  personas: Persona[];
  activePersonaId: string | null;
  generationTopic: string;
  generationInfinite: boolean;
  generationCountLimit: number;
  generationDelaySeconds: number;
  generationIsRunning: boolean;
  setGenerationTopic: Dispatch<SetStateAction<string>>;
  setGenerationInfinite: Dispatch<SetStateAction<boolean>>;
  setGenerationCountLimit: Dispatch<SetStateAction<number>>;
  setGenerationDelaySeconds: Dispatch<SetStateAction<number>>;
  setSidebarTab: Dispatch<SetStateAction<SidebarTab>>;
}

export function useGenerationSessionManager({
  personas,
  activePersonaId,
  generationTopic,
  generationInfinite,
  generationCountLimit,
  generationDelaySeconds,
  generationIsRunning,
  setGenerationTopic,
  setGenerationInfinite,
  setGenerationCountLimit,
  setGenerationDelaySeconds,
  setSidebarTab,
}: UseGenerationSessionManagerParams) {
  const [generationPersonaId, setGenerationPersonaId] = useState("");
  const [generationSessions, setGenerationSessions] = useState<GeneratorSession[]>(
    [],
  );
  const [generationSessionId, setGenerationSessionId] = useState("");
  const [generationCompletedCount, setGenerationCompletedCount] = useState(0);

  const generationSession = useMemo(
    () =>
      generationSessions.find(
        (session) => session.id === generationSessionId,
      ) ?? null,
    [generationSessionId, generationSessions],
  );

  const syncGenerationSessionsFromDb = useCallback(
    async (preferredSessionId?: string | null) => {
      const personaId = generationPersonaId.trim();
      if (!personaId) {
        setGenerationSessions([]);
        setGenerationSessionId("");
        setGenerationCompletedCount(0);
        return;
      }

      try {
        const sessions = await dbApi.getGeneratorSessions(personaId);
        setGenerationSessions(sessions);
        const preferredId = (preferredSessionId ?? "").trim();
        setGenerationSessionId((prev) => {
          if (preferredId && sessions.some((session) => session.id === preferredId)) {
            return preferredId;
          }
          if (prev && sessions.some((session) => session.id === prev)) {
            return prev;
          }
          return sessions[0]?.id ?? "";
        });
      } catch (error) {
        useAppStore.setState({ error: (error as Error).message });
      }
    },
    [generationPersonaId],
  );

  useEffect(() => {
    if (!generationPersonaId && personas.length > 0) {
      setGenerationPersonaId(personas[0].id);
    }
  }, [generationPersonaId, personas]);

  useEffect(() => {
    if (!generationPersonaId) {
      setGenerationSessions([]);
      setGenerationSessionId("");
      setGenerationCompletedCount(0);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const sessions = await dbApi.getGeneratorSessions(generationPersonaId);
        if (cancelled) return;
        setGenerationSessions(sessions);
        if (sessions.length === 0) {
          setGenerationSessionId("");
          setGenerationCompletedCount(0);
          return;
        }
        setGenerationSessionId((prev) => {
          if (prev && sessions.some((session) => session.id === prev)) {
            return prev;
          }
          return sessions[0].id;
        });
      } catch (error) {
        if (!cancelled) {
          useAppStore.setState({ error: (error as Error).message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [generationPersonaId]);

  useEffect(() => {
    setGenerationCompletedCount(generationSession?.completedCount ?? 0);
  }, [generationSession?.completedCount]);

  useEffect(() => {
    if (!generationSession || generationIsRunning) return;
    setGenerationTopic(generationSession.topic);
    setGenerationInfinite(generationSession.isInfinite);
    if (typeof generationSession.requestedCount === "number") {
      setGenerationCountLimit(generationSession.requestedCount);
    }
    setGenerationDelaySeconds(generationSession.delaySeconds);
  }, [
    generationIsRunning,
    generationSession,
    setGenerationCountLimit,
    setGenerationDelaySeconds,
    setGenerationInfinite,
    setGenerationTopic,
  ]);

  const createGenerationSession = async () => {
    const fallbackPersonaId =
      generationPersonaId || activePersonaId || personas[0]?.id || "";
    if (!fallbackPersonaId) {
      useAppStore.setState({
        error: "Нет доступной персоны для создания сессии генератора.",
      });
      return;
    }
    if (fallbackPersonaId !== generationPersonaId) {
      setGenerationPersonaId(fallbackPersonaId);
    }

    const usedNames = new Set(
      generationSessions
        .map((session) => session.name.trim())
        .filter(Boolean),
    );
    let nextName = "Новая сессия";
    if (usedNames.has(nextName)) {
      let index = 2;
      while (usedNames.has(`Новая сессия ${index}`)) {
        index += 1;
      }
      nextName = `Новая сессия ${index}`;
    }

    const now = new Date().toISOString();
    const nextSession: GeneratorSession = {
      id: crypto.randomUUID(),
      personaId: fallbackPersonaId,
      name: nextName,
      topic: generationTopic.trim(),
      isInfinite: generationInfinite,
      requestedCount: generationInfinite
        ? null
        : Math.max(1, Math.floor(generationCountLimit)),
      delaySeconds: Math.max(0, generationDelaySeconds),
      status: "stopped",
      completedCount: 0,
      entries: [],
      createdAt: now,
      updatedAt: now,
    };
    await dbApi.saveGeneratorSession(nextSession);
    setGenerationSessions((prev) => [nextSession, ...prev]);
    setGenerationSessionId(nextSession.id);
    setGenerationCompletedCount(0);
    setSidebarTab("generation");
  };

  const deleteGenerationSession = async (sessionId: string) => {
    await dbApi.deleteGeneratorSession(sessionId);
    let nextSessionId = "";
    setGenerationSessions((prev) => {
      const filtered = prev.filter((session) => session.id !== sessionId);
      nextSessionId = filtered[0]?.id ?? "";
      return filtered;
    });
    setGenerationSessionId((prev) => (prev === sessionId ? nextSessionId : prev));
  };

  const renameGenerationSession = async (
    sessionId: string,
    title: string,
  ) => {
    const currentSession = generationSessions.find(
      (session) => session.id === sessionId,
    );
    if (!currentSession) return;

    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      useAppStore.setState({
        error: "Название сессии генерации не может быть пустым.",
      });
      return;
    }

    if (normalizedTitle === currentSession.topic) return;

    const updatedSession: GeneratorSession = {
      ...currentSession,
      name: normalizedTitle,
      updatedAt: new Date().toISOString(),
    };
    await dbApi.saveGeneratorSession(updatedSession);
    setGenerationSessions((prev) => {
      const next = prev.map((session) =>
        session.id === updatedSession.id ? updatedSession : session,
      );
      return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  };

  return {
    generationPersonaId,
    setGenerationPersonaId,
    generationSessions,
    setGenerationSessions,
    generationSessionId,
    setGenerationSessionId,
    generationCompletedCount,
    setGenerationCompletedCount,
    generationSession,
    syncGenerationSessionsFromDb,
    createGenerationSession,
    deleteGenerationSession,
    renameGenerationSession,
  };
}

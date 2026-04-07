import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listComfyCheckpoints } from "../../comfy";
import { listModels, resolveProviderModelCatalogTarget } from "../../lmstudio";
import { useAppStore } from "../../store";
import type { AppSettings, LlmProvider } from "../../types";

interface UseModelCheckpointCatalogParams {
  initialized: boolean;
  settings: AppSettings;
  settingsDraft: AppSettings;
  setSettingsDraft: Dispatch<SetStateAction<AppSettings>>;
}

export function useModelCheckpointCatalog({
  initialized,
  settings,
  settingsDraft,
  setSettingsDraft,
}: UseModelCheckpointCatalogParams) {
  const [availableModelsByProvider, setAvailableModelsByProvider] = useState<
    Record<LlmProvider, string[]>
  >({
    lmstudio: [],
    openrouter: [],
    huggingface: [],
  });
  const [modelsLoadingByProvider, setModelsLoadingByProvider] = useState<
    Record<LlmProvider, boolean>
  >({
    lmstudio: false,
    openrouter: false,
    huggingface: false,
  });
  const [comfyCheckpoints, setComfyCheckpoints] = useState<string[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);

  const loadModels = async (provider: LlmProvider, baseUrl: string, auth: typeof settingsDraft.lmAuth) => {
    setModelsLoadingByProvider((prev) => ({ ...prev, [provider]: true }));
    try {
      const models = await listModels({
        baseUrl,
        auth,
        apiKey: settingsDraft.apiKey,
      });
      setAvailableModelsByProvider((prev) => ({ ...prev, [provider]: models }));
      if (models.length > 0) {
        setSettingsDraft((v) => ({
          ...v,
          model:
            v.oneToOneProvider === provider
              ? models.includes(v.model)
                ? v.model
                : models[0]
              : v.model,
          groupOrchestratorModel:
            v.groupOrchestratorProvider === provider
              ? models.includes(v.groupOrchestratorModel)
                ? v.groupOrchestratorModel
                : models[0]
              : v.groupOrchestratorModel,
          groupPersonaModel:
            v.groupPersonaProvider === provider
              ? models.includes(v.groupPersonaModel)
                ? v.groupPersonaModel
                : models[0]
              : v.groupPersonaModel,
          imagePromptModel:
            v.imagePromptProvider === provider
              ? models.includes(v.imagePromptModel)
                ? v.imagePromptModel
                : models[0]
              : v.imagePromptModel,
          personaGenerationModel:
            v.personaGenerationProvider === provider
              ? models.includes(v.personaGenerationModel)
                ? v.personaGenerationModel
                : models[0]
              : v.personaGenerationModel,
        }));
      }
    } catch (e) {
      setAvailableModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setModelsLoadingByProvider((prev) => ({ ...prev, [provider]: false }));
    }
  };

  const loadComfyCheckpoints = async (comfyBaseUrl: string) => {
    setCheckpointsLoading(true);
    try {
      const next = await listComfyCheckpoints(
        comfyBaseUrl,
        settingsDraft.comfyAuth,
      );
      setComfyCheckpoints(next);
    } catch (e) {
      setComfyCheckpoints([]);
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setCheckpointsLoading(false);
    }
  };

  useEffect(() => {
    if (!initialized) return;
    const target = resolveProviderModelCatalogTarget(settings, "lmstudio");
    if (!target.baseUrl.trim()) return;
    void loadModels("lmstudio", target.baseUrl, target.auth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, settings.lmBaseUrl, settings.apiKey, settings.lmAuth]);

  useEffect(() => {
    if (!initialized) return;
    if (!settings.comfyBaseUrl.trim()) return;
    void loadComfyCheckpoints(settings.comfyBaseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, settings.comfyBaseUrl, settings.comfyAuth]);

  return {
    availableModels: Array.from(
      new Set([
        ...availableModelsByProvider.lmstudio,
        ...availableModelsByProvider.openrouter,
        ...availableModelsByProvider.huggingface,
      ]),
    ),
    availableModelsByProvider,
    modelsLoading: Object.values(modelsLoadingByProvider).some(Boolean),
    modelsLoadingByProvider,
    comfyCheckpoints,
    checkpointsLoading,
    loadModels,
    loadComfyCheckpoints,
  };
}

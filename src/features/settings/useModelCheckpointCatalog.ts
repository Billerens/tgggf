import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listComfyCheckpoints } from "../../comfy";
import {
  listModels,
  listToolCallableModels,
  listVisionCapableModels,
  resolveProviderModelCatalogTarget,
} from "../../lmstudio";
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
  const [visionModelsByProvider, setVisionModelsByProvider] = useState<
    Record<LlmProvider, string[]>
  >({
    lmstudio: [],
    openrouter: [],
    huggingface: [],
  });
  const [toolModelsByProvider, setToolModelsByProvider] = useState<
    Record<LlmProvider, string[]>
  >({
    lmstudio: [],
    openrouter: [],
    huggingface: [],
  });
  const [comfyCheckpoints, setComfyCheckpoints] = useState<string[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);

  const loadModels = async (provider: LlmProvider, baseUrl: string, auth: typeof settingsDraft.lmAuth) => {
    setModelsLoadingByProvider((prev) => ({ ...prev, [provider]: true }));
    try {
      const [models, visionModels, toolModels] = await Promise.all([
        listModels({
          baseUrl,
          auth,
          apiKey: settingsDraft.apiKey,
        }),
        provider === "openrouter" || provider === "huggingface"
          ? listVisionCapableModels({
              provider,
              baseUrl,
              auth,
              apiKey: settingsDraft.apiKey,
            }).catch((): string[] => [])
          : Promise.resolve([] as string[]),
        provider === "openrouter"
          ? listToolCallableModels({
              provider,
              baseUrl,
              auth,
              apiKey: settingsDraft.apiKey,
            }).catch((): string[] => [])
          : Promise.resolve([] as string[]),
      ]);
      setAvailableModelsByProvider((prev) => ({ ...prev, [provider]: models }));
      setVisionModelsByProvider((prev) => ({
        ...prev,
        [provider]: visionModels,
      }));
      setToolModelsByProvider((prev) => ({
        ...prev,
        [provider]: toolModels,
      }));
      if (models.length > 0) {
        const defaultRoleModels = provider === "openrouter" ? toolModels : models;
        setSettingsDraft((v) => ({
          ...v,
          model:
            v.oneToOneProvider === provider
              ? defaultRoleModels.includes(v.model)
                ? v.model
                : (defaultRoleModels[0] ?? "")
              : v.model,
          groupOrchestratorModel:
            v.groupOrchestratorProvider === provider
              ? defaultRoleModels.includes(v.groupOrchestratorModel)
                ? v.groupOrchestratorModel
                : (defaultRoleModels[0] ?? "")
              : v.groupOrchestratorModel,
          groupPersonaModel:
            v.groupPersonaProvider === provider
              ? defaultRoleModels.includes(v.groupPersonaModel)
                ? v.groupPersonaModel
                : (defaultRoleModels[0] ?? "")
              : v.groupPersonaModel,
          imagePromptModel:
            v.imagePromptProvider === provider
              ? defaultRoleModels.includes(v.imagePromptModel)
                ? v.imagePromptModel
                : (defaultRoleModels[0] ?? "")
              : v.imagePromptModel,
          imageDescriptionModel:
            v.imageDescriptionProvider === provider
              ? provider === "openrouter" || provider === "huggingface"
                ? visionModels.includes(v.imageDescriptionModel)
                  ? v.imageDescriptionModel
                  : (visionModels[0] ?? "")
                : models.includes(v.imageDescriptionModel)
                  ? v.imageDescriptionModel
                  : (models[0] ?? "")
              : v.imageDescriptionModel,
          personaGenerationModel:
            v.personaGenerationProvider === provider
              ? defaultRoleModels.includes(v.personaGenerationModel)
                ? v.personaGenerationModel
                : (defaultRoleModels[0] ?? "")
              : v.personaGenerationModel,
        }));
      }
    } catch (e) {
      setAvailableModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
      setVisionModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
      setToolModelsByProvider((prev) => ({ ...prev, [provider]: [] }));
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
    visionModelsByProvider,
    toolModelsByProvider,
    modelsLoading: Object.values(modelsLoadingByProvider).some(Boolean),
    modelsLoadingByProvider,
    comfyCheckpoints,
    checkpointsLoading,
    loadModels,
    loadComfyCheckpoints,
  };
}

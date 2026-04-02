import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listComfyCheckpoints } from "../../comfy";
import { listModels } from "../../lmstudio";
import { useAppStore } from "../../store";
import type { AppSettings } from "../../types";

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
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [comfyCheckpoints, setComfyCheckpoints] = useState<string[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);

  const loadModels = async (
    baseUrl: string,
    apiKey: string,
    lmAuth: typeof settingsDraft.lmAuth,
  ) => {
    setModelsLoading(true);
    try {
      const models = await listModels({ lmBaseUrl: baseUrl, apiKey, lmAuth });
      setAvailableModels(models);
      if (models.length > 0) {
        setSettingsDraft((v) => ({
          ...v,
          model: models.includes(v.model) ? v.model : models[0],
          imagePromptModel: models.includes(v.imagePromptModel)
            ? v.imagePromptModel
            : models.includes(v.model)
              ? v.model
              : models[0],
          personaGenerationModel: models.includes(v.personaGenerationModel)
            ? v.personaGenerationModel
            : models.includes(v.model)
              ? v.model
              : models[0],
        }));
      }
    } catch (e) {
      setAvailableModels([]);
      useAppStore.setState({ error: (e as Error).message });
    } finally {
      setModelsLoading(false);
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
    if (!settings.lmBaseUrl.trim()) return;
    void loadModels(settings.lmBaseUrl, settings.apiKey, settings.lmAuth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, settings.lmBaseUrl, settings.apiKey, settings.lmAuth]);

  useEffect(() => {
    if (!initialized) return;
    if (!settings.comfyBaseUrl.trim()) return;
    void loadComfyCheckpoints(settings.comfyBaseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, settings.comfyBaseUrl, settings.comfyAuth]);

  return {
    availableModels,
    modelsLoading,
    comfyCheckpoints,
    checkpointsLoading,
    loadModels,
    loadComfyCheckpoints,
  };
}

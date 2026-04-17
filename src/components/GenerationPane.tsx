import { useEffect, useState } from "react";
import { Image, Infinity, Play, Square } from "lucide-react";
import type { ImageGenerationMeta, Persona } from "../types";
import type { LookEnhancePromptOverrides, LookEnhanceTarget } from "../ui/types";
import { resolveSharedEnhancePromptDefaults } from "../features/image-actions/enhancePromptDefaults";
import { ImagePreviewModal } from "./ImagePreviewModal";
import { dbApi } from "../db";

interface GenerationPaneProps {
  activePersona: Persona | null;
  generationSessionId: string;
  topic: string;
  onTopicChange: (value: string) => void;
  promptMode: "theme_llm" | "direct_prompt";
  onPromptModeChange: (value: "theme_llm" | "direct_prompt") => void;
  directPromptSeed: number | null;
  onDirectPromptSeedChange: (value: number | null) => void;
  isInfinite: boolean;
  onInfiniteChange: (value: boolean) => void;
  countLimit: number;
  onCountLimitChange: (value: number) => void;
  delaySeconds: number;
  onDelaySecondsChange: (value: number) => void;
  isRunning: boolean;
  completedCount: number;
  generatedImageUrls: string[];
  imageMetaByUrl: Record<string, ImageGenerationMeta>;
  pendingImageCount: number;
  imageActionBusy: boolean;
  onEnhanceImage: (payload: {
    sessionId: string;
    sourceUrl: string;
    meta?: ImageGenerationMeta;
  }, targetOverride?: LookEnhanceTarget, promptOverride?: string | LookEnhancePromptOverrides) => void;
  onRegenerateImage: (
    payload: {
      sessionId: string;
      sourceUrl: string;
      meta?: ImageGenerationMeta;
    },
    promptOverride?: string,
  ) => void;
  onStart: () => void;
  onSingleGenerate: () => void;
  canSingleGenerate: boolean;
  onStop: () => void;
}

function parseIdbAssetId(value: string) {
  const normalized = value.trim();
  if (!normalized.startsWith("idb://")) return "";
  return normalized.slice("idb://".length).trim();
}

export function GenerationPane({
  activePersona,
  generationSessionId,
  topic,
  onTopicChange,
  promptMode,
  onPromptModeChange,
  directPromptSeed,
  onDirectPromptSeedChange,
  isInfinite,
  onInfiniteChange,
  countLimit,
  onCountLimitChange,
  delaySeconds,
  onDelaySecondsChange,
  isRunning,
  completedCount,
  generatedImageUrls,
  imageMetaByUrl,
  pendingImageCount,
  imageActionBusy,
  onEnhanceImage,
  onRegenerateImage,
  onStart,
  onSingleGenerate,
  canSingleGenerate,
  onStop,
}: GenerationPaneProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<ImageGenerationMeta | undefined>(undefined);
  const [previewTarget, setPreviewTarget] = useState<{
    sessionId: string;
    sourceUrl: string;
    sourceIndex: number;
  } | null>(null);
  const [resolvedImageBySource, setResolvedImageBySource] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (!previewTarget) return;
    const nextSource = generatedImageUrls[previewTarget.sourceIndex] ?? "";
    if (!nextSource) return;
    const resolvedPreview =
      resolvedImageBySource[nextSource] ??
      (parseIdbAssetId(nextSource) ? "" : nextSource);
    if (resolvedPreview && resolvedPreview === previewSrc) return;
    setPreviewSrc(resolvedPreview || null);
    setPreviewMeta(imageMetaByUrl[nextSource]);
    setPreviewTarget((prev) =>
      prev
        ? {
            ...prev,
            sourceUrl: nextSource,
          }
        : prev,
    );
  }, [
    generatedImageUrls,
    imageMetaByUrl,
    previewTarget,
    previewSrc,
    resolvedImageBySource,
  ]);

  useEffect(() => {
    let cancelled = false;
    const loadResolved = async () => {
      const nextResolved: Record<string, string> = {};
      const refsById = new Map<string, string[]>();
      for (const sourceUrl of generatedImageUrls) {
        const assetId = parseIdbAssetId(sourceUrl);
        if (!assetId) {
          nextResolved[sourceUrl] = sourceUrl;
          continue;
        }
        const bucket = refsById.get(assetId) ?? [];
        bucket.push(sourceUrl);
        refsById.set(assetId, bucket);
      }
      if (refsById.size > 0) {
        const assets = await dbApi.getImageAssets(Array.from(refsById.keys()));
        const assetDataUrlById = Object.fromEntries(
          assets.map((asset) => [asset.id, asset.dataUrl]),
        );
        for (const [assetId, sourceUrls] of refsById.entries()) {
          const resolvedDataUrl = assetDataUrlById[assetId] ?? "";
          for (const sourceUrl of sourceUrls) {
            nextResolved[sourceUrl] = resolvedDataUrl;
          }
        }
      }
      if (!cancelled) {
        setResolvedImageBySource(nextResolved);
      }
    };
    void loadResolved();
    return () => {
      cancelled = true;
    };
  }, [generatedImageUrls]);
  const previewResolvedMeta = previewTarget
    ? previewMeta ?? imageMetaByUrl[previewTarget.sourceUrl]
    : previewMeta;
  const previewEnhancePromptDefaults = previewTarget
    ? resolveSharedEnhancePromptDefaults(activePersona, previewResolvedMeta)
    : undefined;
  const isDirectPromptMode = promptMode === "direct_prompt";

  return (
    <>
      <main className="chat generation-pane">
        <header className="chat-header">
        <div>
          <h2>Генерация</h2>
          <p>
            Авто-режим генерации по теме с отдельными сессиями. Результаты не сохраняются в чат.
          </p>
        </div>
        <div className="header-actions">
          {isRunning ? (
            <button type="button" className="danger" onClick={onStop}>
              <Square size={14} /> Стоп
            </button>
          ) : (
            <>
              <button type="button" className="primary" onClick={onStart}>
                <Play size={14} /> Старт
              </button>
              <button
                type="button"
                onClick={onSingleGenerate}
                disabled={!canSingleGenerate}
              >
                <Image size={14} /> Сгенерировать 1
              </button>
            </>
          )}
        </div>
        </header>

        <section className="generation-content">
        <div className="generation-form">
          <label>
            {isDirectPromptMode ? "Direct ComfyUI prompt" : "Тематика генерации"}
            <textarea
              value={topic}
              onChange={(event) => onTopicChange(event.target.value)}
              placeholder={
                isDirectPromptMode
                  ? "Например: masterpiece, best quality, solo, one person, cinematic lighting, rainy neon city, upper body"
                  : "Например: дождливый неон-город ночью, cinematic, street style"
              }
              rows={3}
              disabled={isRunning}
            />
          </label>

          <div className="generation-grid">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={isDirectPromptMode}
                onChange={(event) =>
                  onPromptModeChange(
                    event.target.checked ? "direct_prompt" : "theme_llm",
                  )
                }
                disabled={isRunning}
              />
              <span>Skip LLM theme (direct prompt)</span>
            </label>

            {isDirectPromptMode ? (
              <label>
                Seed (one-shot, optional)
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={directPromptSeed ?? ""}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    if (!raw) {
                      onDirectPromptSeedChange(null);
                      return;
                    }
                    const parsed = Number(raw);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      onDirectPromptSeedChange(null);
                      return;
                    }
                    onDirectPromptSeedChange(Math.floor(parsed));
                  }}
                  disabled={isRunning}
                />
              </label>
            ) : null}

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={isInfinite}
                onChange={(event) => onInfiniteChange(event.target.checked)}
                disabled={isRunning}
              />
              <span>
                <Infinity size={14} /> Бесконечная генерация
              </span>
            </label>

            <label>
              Количество генераций
              <input
                type="number"
                min={1}
                max={100000}
                step={1}
                value={countLimit}
                onChange={(event) => onCountLimitChange(Number(event.target.value))}
                disabled={isRunning || isInfinite}
              />
            </label>

            <label>
              Интервал между запросами (сек)
              <input
                type="number"
                min={0}
                max={120}
                step={1}
                value={delaySeconds}
                onChange={(event) => onDelaySecondsChange(Number(event.target.value))}
                disabled={isRunning}
              />
            </label>
          </div>

          <div className="generation-stats">
            <span>Статус: {isRunning ? "выполняется" : "ожидание"}</span>
            <span>
              Режим: {isDirectPromptMode ? "direct prompt" : "LLM theme"}
            </span>
            <span>Выполнено итераций: {completedCount}</span>
            <span>
              Изображений в активной сессии: {generatedImageUrls.length}
            </span>
          </div>
        </div>

        <div className="generation-gallery">
          {generatedImageUrls.length === 0 && pendingImageCount === 0 ? (
            <p className="empty-state">Сгенерированные изображения появятся здесь.</p>
          ) : (
            <div className="bubble-images">
              {generatedImageUrls.map((url, index) => (
                <button
                  type="button"
                  key={`${url}-${index}`}
                  className="bubble-image-btn"
                  onClick={() => {
                    const resolvedSrc =
                      resolvedImageBySource[url] ?? (parseIdbAssetId(url) ? "" : url);
                    setPreviewSrc(resolvedSrc || null);
                    const meta = imageMetaByUrl[url];
                    setPreviewMeta(meta);
                    setPreviewTarget(
                      generationSessionId
                        ? {
                            sessionId: generationSessionId,
                            sourceUrl: url,
                            sourceIndex: index,
                          }
                        : null,
                    );
                  }}
                >
                  {(() => {
                    const resolvedSrc =
                      resolvedImageBySource[url] ?? (parseIdbAssetId(url) ? "" : url);
                    if (!resolvedSrc) {
                      return <div className="image-skeleton-card" />;
                    }
                    return (
                      <img src={resolvedSrc} alt={`generated-${index + 1}`} loading="lazy" />
                    );
                  })()}
                </button>
              ))}
              {Array.from({ length: pendingImageCount }).map((_, index) => (
                <div key={`pending-${index}`} className="image-skeleton-card" />
              ))}
            </div>
          )}
          <p className="generation-note">
            <Image size={14} /> Галерея показывает изображения активной сессии генератора.
          </p>
        </div>
        </section>
      </main>
      <ImagePreviewModal
        src={previewSrc}
        meta={previewResolvedMeta}
        enhancePromptDefaults={previewEnhancePromptDefaults}
        actionBusy={imageActionBusy}
        onEnhance={
          previewTarget
            ? (targetOverride, promptOverride) => {
                const effectivePromptOverride =
                  promptOverride ?? previewEnhancePromptDefaults;
                onEnhanceImage(
                  {
                    sessionId: previewTarget.sessionId,
                    sourceUrl: previewTarget.sourceUrl,
                    meta: previewResolvedMeta,
                  },
                  targetOverride,
                  effectivePromptOverride,
                );
              }
            : undefined
        }
        onRegenerate={
          previewTarget
            ? (promptOverride) => {
                onRegenerateImage(
                  {
                    sessionId: previewTarget.sessionId,
                    sourceUrl: previewTarget.sourceUrl,
                    meta: previewResolvedMeta,
                  },
                  promptOverride,
                );
              }
            : undefined
        }
        onClose={() => {
          setPreviewSrc(null);
          setPreviewMeta(undefined);
          setPreviewTarget(null);
        }}
      />
    </>
  );
}

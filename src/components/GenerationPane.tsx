import { useState } from "react";
import { Image, Infinity, Play, Square } from "lucide-react";
import type { ImageGenerationMeta } from "../types";
import { ImagePreviewModal } from "./ImagePreviewModal";

interface GenerationPaneProps {
  topic: string;
  onTopicChange: (value: string) => void;
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
  onStart: () => void;
  onStop: () => void;
}

export function GenerationPane({
  topic,
  onTopicChange,
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
  onStart,
  onStop,
}: GenerationPaneProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<ImageGenerationMeta | undefined>(undefined);

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
            <button type="button" className="primary" onClick={onStart}>
              <Play size={14} /> Старт
            </button>
          )}
        </div>
        </header>

        <section className="generation-content">
        <div className="generation-form">
          <label>
            Тематика генерации
            <textarea
              value={topic}
              onChange={(event) => onTopicChange(event.target.value)}
              placeholder="Например: дождливый неон-город ночью, cinematic, street style"
              rows={3}
              disabled={isRunning}
            />
          </label>

          <div className="generation-grid">
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
                    setPreviewSrc(url);
                    setPreviewMeta(imageMetaByUrl[url]);
                  }}
                >
                  <img src={url} alt={`generated-${index + 1}`} loading="lazy" />
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
        meta={previewMeta}
        onClose={() => {
          setPreviewSrc(null);
          setPreviewMeta(undefined);
        }}
      />
    </>
  );
}

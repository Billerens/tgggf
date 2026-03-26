function isDataUrl(value: string) {
  return value.startsWith("data:");
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
        return;
      }
      reject(new Error("Не удалось преобразовать blob в data URL."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Ошибка чтения blob."));
    reader.readAsDataURL(blob);
  });
}

async function convertBlobToWebpDataUrl(blob: Blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D context недоступен.");
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const webpBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/webp", 0.9);
    });

    if (!webpBlob) {
      throw new Error("Canvas.toBlob вернул null.");
    }

    return await blobToDataUrl(webpBlob);
  } catch {
    return blobToDataUrl(blob);
  }
}

async function fetchImageBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить изображение: ${response.status}`);
  }
  return response.blob();
}

async function toLocalDataUrl(source: string) {
  const value = source.trim();
  if (!value) return "";
  if (isDataUrl(value)) return value;
  const blob = await fetchImageBlob(value);
  return convertBlobToWebpDataUrl(blob);
}

export async function localizeImageUrls(sources: string[]) {
  const localized: string[] = [];

  for (const source of sources) {
    const value = source.trim();
    if (!value) continue;
    try {
      const dataUrl = await toLocalDataUrl(value);
      if (dataUrl) localized.push(dataUrl);
    } catch {
      // Fallback to original URL when CORS/network conversion is not possible.
      localized.push(value);
    }
  }

  return Array.from(new Set(localized));
}


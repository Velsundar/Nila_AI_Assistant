/** Max encoded payload we send to /receipts/scan (the API accepts ~4 MB decoded). */
const MAX_BYTES = 3.5 * 1024 * 1024;

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to <img> (older Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This image couldn't be read. Try a JPEG or PNG photo of the receipt.");
  }
}

/**
 * Downscale an image client-side (canvas) to at most `maxSide` px on its longest side and
 * re-encode as JPEG, shrinking further until the data URL fits the API's limit.
 */
export async function imageToJpegDataUrl(file: Blob, maxSide = 1600): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Pick an image file (JPEG, PNG or WebP).");
  const img = await decode(file);
  try {
    let side = maxSide;
    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas isn't available in this browser.");
      ctx.fillStyle = "#fff"; // transparent PNGs → white, not black, in JPEG
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img.source, 0, 0, w, h);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length * 0.75 <= MAX_BYTES) return url;
      quality = Math.max(0.5, quality - 0.12);
      side = Math.round(side * 0.8);
    }
    throw new Error("That image is too large even after shrinking it.");
  } finally {
    img.close();
  }
}

/** Blob → data URL with a clean MIME type (codec params stripped), e.g. "data:audio/webm;base64,…". */
export function blobToDataUrl(blob: Blob, mime = blob.type.split(";")[0] || "application/octet-stream"): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the recording."));
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(",");
      resolve(`data:${mime};base64,${s.slice(comma + 1)}`);
    };
    r.readAsDataURL(blob);
  });
}

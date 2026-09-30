"use client";

/**
 * On-device OCR for screenshots.
 *
 * Tesseract runs as WebAssembly in the browser, so a clean screenshot can be
 * turned into text without an API call. It is lazily imported — nothing is
 * downloaded until the first time OCR actually runs — and the worker is kept
 * alive between images, because spinning one up costs more than recognising a
 * page does.
 *
 * OCR is only trusted when it is confident. A blurry or dark-mode screenshot
 * scores badly, and the caller falls back to the vision model instead of
 * feeding it garbage.
 */

import { contrastStops, histogram, normalisePixels, ocrScale, shouldInvert } from "./ocrPrep";

type TesseractWorker = {
  recognize: (image: string) => Promise<{ data: { text: string; confidence: number } }>;
  terminate: () => Promise<unknown>;
};

export type OcrResult = {
  text: string;
  confidence: number;
  /** Confident enough to use instead of the vision model. */
  usable: boolean;
};

/** Tesseract reports 0-100. Below this, screenshots tend to be mis-read. */
const MIN_CONFIDENCE = 72;
const MIN_CHARS = 80;

let workerPromise: Promise<TesseractWorker> | null = null;

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      return (await createWorker("eng")) as unknown as TesseractWorker;
    })();
    // A failed load must not poison every later attempt.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

/**
 * Upscales, flattens to grey, stretches the contrast, and inverts a dark-mode
 * screenshot. Returns null if the canvas is unavailable, in which case the
 * original image is used unchanged.
 */
async function preprocess(dataUrl: string): Promise<{ dataUrl: string; inverted: boolean } | null> {
  try {
    const response = await fetch(dataUrl);
    const bitmap = await createImageBitmap(await response.blob());

    try {
      const scale = ocrScale(bitmap.width, bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;

      // Smoothing on the upscale keeps letter strokes continuous rather than
      // stepped, which matters more to a recogniser than sharpness does.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, width, height);

      const image = ctx.getImageData(0, 0, width, height);
      const bins = histogram(image.data);
      const inverted = shouldInvert(bins);
      normalisePixels(image.data, contrastStops(bins), inverted);
      ctx.putImageData(image, 0, 0);

      // PNG, not JPEG: a second lossy pass would undo the cleanup.
      return { dataUrl: canvas.toDataURL("image/png"), inverted };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

function tidy(raw: string): string {
  return raw.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function recognise(dataUrl: string): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(dataUrl);
  const text = tidy(data.text);

  return {
    text,
    confidence: Math.round(data.confidence),
    usable: data.confidence >= MIN_CONFIDENCE && text.length >= MIN_CHARS,
  };
}

export async function ocrImage(dataUrl: string): Promise<OcrResult> {
  const prepared = await preprocess(dataUrl);
  if (!prepared) return recognise(dataUrl);

  const cleaned = await recognise(prepared.dataUrl);
  if (cleaned.usable) return cleaned;

  // Preprocessing usually helps and occasionally hurts — a heavily styled
  // posting, a screenshot that was already clean. One retry on the original
  // costs a second and recovers those.
  const original = await recognise(dataUrl);
  return original.confidence > cleaned.confidence ? original : cleaned;
}

/** Frees the WASM worker; safe to call when no worker was ever created. */
export async function releaseOcr() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    /* already gone */
  }
}

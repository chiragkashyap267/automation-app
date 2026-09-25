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

export async function ocrImage(dataUrl: string): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(dataUrl);

  const text = data.text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  return {
    text,
    confidence: Math.round(data.confidence),
    usable: data.confidence >= MIN_CONFIDENCE && text.length >= MIN_CHARS,
  };
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

/**
 * Cleaning a screenshot up before Tesseract sees it.
 *
 * The image that reaches OCR has already been downscaled to 1600px and JPEG
 * encoded for the model's benefit, which is close to the worst input for
 * character recognition: soft edges, compression noise, and — on a phone —
 * very often light text on a dark background, which Tesseract reads badly.
 *
 * The pixel maths lives here as plain functions over a pixel buffer so it can
 * be tested without a browser; the canvas work that feeds it is at the bottom
 * and only runs client-side.
 */

/** Rec. 709 luma, the same weighting the eye uses. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A 256-bucket count of how bright the pixels are. */
export function histogram(pixels: Uint8ClampedArray): Uint32Array {
  const bins = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i += 4) {
    bins[Math.round(luminance(pixels[i], pixels[i + 1], pixels[i + 2]))] += 1;
  }
  return bins;
}

export function meanLuminance(bins: Uint32Array): number {
  let total = 0;
  let weighted = 0;
  for (let v = 0; v < 256; v++) {
    total += bins[v];
    weighted += v * bins[v];
  }
  return total ? weighted / total : 0;
}

/**
 * Dark mode, essentially.
 *
 * Text is a minority of the pixels, so a screenshot's average brightness is
 * really its background. Below the midpoint means light text on dark, which
 * Tesseract is trained against and reads far worse than the inverse.
 */
export function shouldInvert(bins: Uint32Array): boolean {
  return meanLuminance(bins) < 110;
}

/**
 * Where to clip the histogram so the page becomes properly black on white.
 *
 * A flat screenshot might only span 90-200; stretching that to 0-255 sharpens
 * every edge. The percentiles ignore outliers — one pure-white icon should
 * not define the top of the range.
 */
export function contrastStops(bins: Uint32Array, clipPercent = 0.5): { low: number; high: number } {
  let total = 0;
  for (let v = 0; v < 256; v++) total += bins[v];
  if (!total) return { low: 0, high: 255 };

  const cut = (total * clipPercent) / 100;

  let low = 0;
  for (let seen = 0, v = 0; v < 256; v++) {
    seen += bins[v];
    if (seen > cut) {
      low = v;
      break;
    }
  }

  let high = 255;
  for (let seen = 0, v = 255; v >= 0; v--) {
    seen += bins[v];
    if (seen > cut) {
      high = v;
      break;
    }
  }

  // A blank or near-blank image can invert the two; leave it alone instead.
  if (high - low < 16) return { low: 0, high: 255 };
  return { low, high };
}

/**
 * Flattens to grayscale, stretches the contrast, and optionally inverts.
 * Mutates the buffer, which is what the canvas API wants back.
 */
export function normalisePixels(
  pixels: Uint8ClampedArray,
  { low, high }: { low: number; high: number },
  invert: boolean,
): Uint8ClampedArray {
  const span = Math.max(1, high - low);

  for (let i = 0; i < pixels.length; i += 4) {
    const grey = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
    let value = ((grey - low) / span) * 255;
    if (invert) value = 255 - value;
    const clamped = value < 0 ? 0 : value > 255 ? 255 : value;
    pixels[i] = clamped;
    pixels[i + 1] = clamped;
    pixels[i + 2] = clamped;
  }
  return pixels;
}

/**
 * Tesseract wants roughly 300 DPI. A 1600px screenshot of a phone screen is
 * well under that for body text, and upscaling before recognition measurably
 * helps — but past a point it only costs time, hence the ceiling.
 */
export const OCR_TARGET_EDGE = 2400;

export function ocrScale(width: number, height: number, target = OCR_TARGET_EDGE): number {
  const longEdge = Math.max(width, height);
  if (!longEdge) return 1;
  // Never shrink: detail lost here cannot be recovered by the recogniser.
  return Math.min(2, Math.max(1, target / longEdge));
}

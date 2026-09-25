/**
 * Screenshots come off phones at 3-4 MP, which blows past the serverless body
 * limit and costs tokens for detail the model does not need. Downscale to a
 * long edge of 1600px and re-encode as JPEG before anything leaves the browser.
 */
const MAX_EDGE = 1600;
const QUALITY = 0.82;

/**
 * Vercel caps a serverless request body at 4.5 MB and the screenshots travel
 * inside it as base64. Capping each image keeps a merged multi-page posting
 * comfortably inside that, and cuts tokens too.
 */
const MAX_BASE64_BYTES = 320 * 1024;
const FALLBACK_STEPS: [number, number][] = [
  [1400, 0.72],
  [1200, 0.65],
  [1000, 0.6],
];

export type PreparedImage = {
  mediaType: string;
  data: string;
  preview: string;
};

function render(bitmap: ImageBitmap, maxEdge: number, quality: number): string {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not read that image.");
  ctx.drawImage(bitmap, 0, 0, width, height);

  return canvas.toDataURL("image/jpeg", quality);
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);

  try {
    let dataUrl = render(bitmap, MAX_EDGE, QUALITY);

    // Step down only as far as needed; OCR and vision both suffer at low
    // resolution, so the first pass that fits is the one we keep.
    for (const [edge, quality] of FALLBACK_STEPS) {
      if (dataUrl.length - dataUrl.indexOf(",") - 1 <= MAX_BASE64_BYTES) break;
      dataUrl = render(bitmap, edge, quality);
    }

    const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return { mediaType: "image/jpeg", data, preview: dataUrl };
  } finally {
    bitmap.close();
  }
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

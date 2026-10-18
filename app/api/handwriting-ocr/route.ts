export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxImageBytes = 8 * 1024 * 1024;
const maxRequestBytes = maxImageBytes + 64 * 1024;
const supportedImageTypes = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Cross-origin OCR requests are not allowed." }, { status: 403 });
  }

  const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Cloud handwriting OCR is not configured. Set GOOGLE_CLOUD_VISION_API_KEY on the server." },
      { status: 503 },
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    return Response.json({ error: "Image is too large. Choose an image smaller than 8 MB." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Upload a valid answer-sheet image." }, { status: 400 });
  }

  const image = formData.get("image");
  if (!(image instanceof File)) {
    return Response.json({ error: "Choose an answer-sheet image to scan." }, { status: 400 });
  }
  if (!supportedImageTypes.has(image.type)) {
    return Response.json({ error: "Use a JPEG, PNG, WebP, BMP, or GIF image." }, { status: 415 });
  }
  if (image.size === 0) {
    return Response.json({ error: "The selected image is empty." }, { status: 400 });
  }
  if (image.size > maxImageBytes) {
    return Response.json({ error: "Image is too large. Choose an image smaller than 8 MB." }, { status: 413 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{
            image: { content: Buffer.from(await image.arrayBuffer()).toString("base64") },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          }],
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    console.error("Google Cloud Vision handwriting OCR could not be reached.");
    return Response.json({ error: "Cloud handwriting OCR could not be reached. Try again." }, { status: 502 });
  }

  let result: unknown;
  try {
    result = await upstream.json();
  } catch {
    console.error("Google Cloud Vision handwriting OCR returned invalid JSON.");
    return Response.json({ error: "Cloud handwriting OCR returned an invalid response." }, { status: 502 });
  }

  if (!upstream.ok) {
    console.error("Google Cloud Vision handwriting OCR failed with status:", upstream.status);
    return Response.json(
      { error: "Cloud handwriting OCR failed. Check the API key, Vision API access, and service quota." },
      { status: 502 },
    );
  }

  const responses = isRecord(result) && Array.isArray(result.responses) ? result.responses : [];
  const firstResponse = responses[0];
  const annotation = isRecord(firstResponse) && isRecord(firstResponse.fullTextAnnotation)
    ? firstResponse.fullTextAnnotation
    : null;
  const text = annotation && typeof annotation.text === "string" ? annotation.text.trim() : "";
  const pages = annotation && Array.isArray(annotation.pages) ? annotation.pages : [];
  const page = pages[0];
  const width = isRecord(page) && typeof page.width === "number" ? page.width : 0;
  const height = isRecord(page) && typeof page.height === "number" ? page.height : 0;
  const words: { text: string; x0: number; y0: number; x1: number; y1: number }[] = [];

  if (isRecord(page) && Array.isArray(page.blocks)) {
    for (const block of page.blocks) {
      if (!isRecord(block) || !Array.isArray(block.paragraphs)) continue;
      for (const paragraph of block.paragraphs) {
        if (!isRecord(paragraph) || !Array.isArray(paragraph.words)) continue;
        for (const word of paragraph.words) {
          if (!isRecord(word) || !Array.isArray(word.symbols) || !isRecord(word.boundingBox)) continue;
          const vertices = Array.isArray(word.boundingBox.vertices) ? word.boundingBox.vertices : [];
          const points = vertices.filter((vertex): vertex is Record<string, unknown> => isRecord(vertex));
          if (points.length === 0) continue;
          const xCoordinates = points.map((point) => typeof point.x === "number" ? point.x : 0);
          const yCoordinates = points.map((point) => typeof point.y === "number" ? point.y : 0);
          const wordText = word.symbols
            .filter(isRecord)
            .map((symbol) => typeof symbol.text === "string" ? symbol.text : "")
            .join("");
          if (!wordText) continue;
          words.push({
            text: wordText,
            x0: Math.min(...xCoordinates),
            y0: Math.min(...yCoordinates),
            x1: Math.max(...xCoordinates),
            y1: Math.max(...yCoordinates),
          });
        }
      }
    }
  }

  return Response.json({ text, width, height, words });
}

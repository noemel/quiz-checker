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
const supportedAnswerTypes = new Set([
  "multiple-choice",
  "true-false",
  "identification",
  "matching",
]);

interface RequestedItem {
  questionNumber: number;
  answerType: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseItems(value: FormDataEntryValue | null): RequestedItem[] | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) return null;
  const items: RequestedItem[] = [];
  const seen = new Set<number>();
  for (const entry of parsed) {
    if (!isRecord(entry)
      || typeof entry.questionNumber !== "number"
      || !Number.isInteger(entry.questionNumber)
      || entry.questionNumber < 1
      || typeof entry.answerType !== "string"
      || !supportedAnswerTypes.has(entry.answerType)
      || seen.has(entry.questionNumber)) return null;
    seen.add(entry.questionNumber);
    items.push({ questionNumber: entry.questionNumber, answerType: entry.answerType });
  }
  return items;
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "Cross-origin transcription requests are not allowed." }, { status: 403 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Gemini visual transcription is not configured. Set GEMINI_API_KEY on the server." },
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
  const items = parseItems(formData.get("items"));
  if (!(image instanceof File)) {
    return Response.json({ error: "Choose an answer-sheet image to transcribe." }, { status: 400 });
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
  if (!items) {
    return Response.json({ error: "The requested answer-sheet items are invalid." }, { status: 400 });
  }

  const itemList = items
    .map(({ questionNumber, answerType }) => `${questionNumber} (${answerType})`)
    .join(", ");
  const prompt = [
    "Transcribe the student's handwritten answers from this answer-sheet image by visually inspecting the marks and handwriting.",
    "This is visual transcription, not answer grading. Do not infer an answer from an answer key or invent missing answers.",
    "Only return answers for these item numbers: " + itemList + ".",
    "For multiple-choice or matching rows, return the selected option letter. For true/false, return True or False. For identification, transcribe the written answer as faithfully as possible.",
    "If a row is blank or you cannot confidently read it, return an empty answer string for that item.",
    'Return only JSON in this exact shape: {"answers":[{"questionNumber":1,"answer":"","confidence":"low"}]}. Confidence must be one of "high", "medium", or "low". Include every requested item exactly once.',
  ].join("\n");

  let upstream: Response;
  try {
    upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: image.type,
                  data: Buffer.from(await image.arrayBuffer()).toString("base64"),
                },
              },
            ],
          }],
          generationConfig: { responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch {
    console.error("Gemini answer-sheet visual transcription could not be reached.");
    return Response.json({ error: "Gemini visual transcription could not be reached. Try again." }, { status: 502 });
  }

  let result: unknown;
  try {
    result = await upstream.json();
  } catch {
    console.error("Gemini answer-sheet visual transcription returned invalid JSON.");
    return Response.json({ error: "Gemini returned an invalid response. Try again." }, { status: 502 });
  }

  if (!upstream.ok) {
    console.error("Gemini answer-sheet visual transcription failed with status:", upstream.status);
    return Response.json(
      { error: "Gemini visual transcription failed. Check the API key, model access, and service quota." },
      { status: 502 },
    );
  }

  const candidates = isRecord(result) && Array.isArray(result.candidates) ? result.candidates : [];
  const firstCandidate = candidates[0];
  const content = isRecord(firstCandidate) && isRecord(firstCandidate.content) ? firstCandidate.content : null;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const responseText = parts
    .filter((part) => isRecord(part) && typeof part.text === "string")
    .map((part) => (part as { text: string }).text)
    .join("")
    .trim();

  let transcription: unknown;
  try {
    transcription = JSON.parse(responseText);
  } catch {
    console.error("Gemini answer-sheet visual transcription returned malformed answer JSON.");
    return Response.json({ error: "Gemini could not return a usable transcription. Try again or enter answers manually." }, { status: 502 });
  }

  const answerRows = isRecord(transcription) && Array.isArray(transcription.answers)
    ? transcription.answers : null;
  if (!answerRows) {
    return Response.json({ error: "Gemini returned an unexpected answer format. Try again or enter answers manually." }, { status: 502 });
  }

  const allowedItems = new Set(items.map((item) => item.questionNumber));
  const answers = answerRows.flatMap((row) => {
    if (!isRecord(row)
      || typeof row.questionNumber !== "number"
      || !Number.isInteger(row.questionNumber)
      || !allowedItems.has(row.questionNumber)
      || typeof row.answer !== "string") return [];
    const confidence = row.confidence === "high" || row.confidence === "medium" || row.confidence === "low"
      ? row.confidence : "low";
    return [{ questionNumber: row.questionNumber, answer: row.answer.slice(0, 500), confidence }];
  });
  const uniqueAnswers = [...new Map(answers.map((answer) => [answer.questionNumber, answer])).values()];
  return Response.json({ answers: uniqueAnswers });
}

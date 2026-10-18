'use client';

import { createWorker, PSM } from "tesseract.js";
import Image from "next/image";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { ExamQuestion, ExamType, SavedExam } from "@/app/lib/exam-types";
import { createAnswerSheetLayout, pageIndexFromOcr } from "./answer-sheet-omr";

interface AnswerCheckRow {
  number: number;
  type: ExamType;
  response: string;
  expected: string;
  status: "correct" | "review" | "unanswered";
}

const typeLabels: Record<ExamType, string> = {
  "multiple-choice": "Multiple Choice",
  "true-false": "True or False",
  identification: "Identification",
  matching: "Matching Type",
};

const answerLetters = ["A", "B", "C", "D"];

interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface AnswerRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface AnswerCrop {
  questionIndex: number;
  type: ExamType;
  region: AnswerRegion;
}

interface AnswerContactSheet {
  file: File;
  crops: AnswerCrop[];
  scale: number;
  padding: number;
  cellHeight: number;
}

function isOcrWord(value: unknown): value is OcrWord {
  if (typeof value !== "object" || value === null) return false;
  const word = value as Record<string, unknown>;
  return typeof word.text === "string"
    && typeof word.x0 === "number"
    && typeof word.y0 === "number"
    && typeof word.x1 === "number"
    && typeof word.y1 === "number";
}

async function recognizeWithCloudOcr(file: File) {
  const formData = new FormData();
  formData.append("image", file);
  const response = await fetch("/api/handwriting-ocr", { method: "POST", body: formData });
  const result: unknown = await response.json().catch(() => null);
  const cloudResult = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const error = typeof cloudResult.error === "string"
    ? cloudResult.error : "Cloud handwriting OCR returned an invalid response.";
  if (!response.ok) throw new Error(error);
  const words = Array.isArray(cloudResult.words) ? cloudResult.words.filter(isOcrWord) : [];
  if (!words.length) throw new Error("No text positions were detected in the image.");
  return {
    text: typeof cloudResult.text === "string" ? cloudResult.text : "",
    words,
    width: typeof cloudResult.width === "number" ? cloudResult.width : 0,
    height: typeof cloudResult.height === "number" ? cloudResult.height : 0,
  };
}

function normalizeAnswer(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function getOcrWords(blocks: {
  paragraphs: {
    lines: {
      words: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
    }[];
  }[];
}[] | null) {
  return (blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) =>
    paragraph.lines.flatMap((line) => line.words.map((word) => ({
      text: word.text,
      x0: word.bbox.x0,
      y0: word.bbox.y0,
      x1: word.bbox.x1,
      y1: word.bbox.y1,
    }))),
  ));
}

function getAnswerRegions(
  words: OcrWord[],
  width: number,
  height: number,
  layout: ReturnType<typeof createAnswerSheetLayout>,
  pageIndex: number,
) {
  const rows = layout.rows.filter((row) => row.page === pageIndex);
  const anchors = new Map<number, OcrWord>();
  for (const row of rows) {
    const itemNumber = String(row.questionIndex + 1);
    const candidates = words.filter((word) => word.text.replace(/[^0-9]/g, "") === itemNumber);
    const anchor = candidates.sort((a, b) => a.y0 - b.y0)[0];
    if (anchor) anchors.set(row.questionIndex, anchor);
  }

  const rowsByColumn = [0, 1].map((column) => rows
    .filter((row) => row.column === column)
    .map((row) => anchors.get(row.questionIndex))
    .filter((anchor): anchor is OcrWord => Boolean(anchor))
    .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2));
  const columnCenters = rowsByColumn.map((columnAnchors) => {
    const centers = columnAnchors.map((anchor) => (anchor.x0 + anchor.x1) / 2).sort((a, b) => a - b);
    return centers.length ? centers[Math.floor(centers.length / 2)] : null;
  });
  const columnBoundary = columnCenters[0] !== null && columnCenters[1] !== null
    ? (columnCenters[0] + columnCenters[1]) / 2
    : width / 2;
  const columnWidths = [
    columnBoundary,
    columnCenters[1] !== null
      ? Math.max(1, columnCenters[1] - columnBoundary)
      : Math.max(1, width - columnBoundary),
  ];
  const medianRowHeight = rowsByColumn.map((columnAnchors) => {
    const gaps = columnAnchors.slice(1).map((anchor, index) =>
      (anchor.y0 + anchor.y1 - columnAnchors[index].y0 - columnAnchors[index].y1) / 2,
    ).filter((gap) => gap > 0);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] ?? (height * 7.5 / 330.2);
  });

  return new Map(rows.flatMap((row) => {
    const anchor = anchors.get(row.questionIndex);
    if (!anchor) return [];
    const rowHeight = medianRowHeight[row.column];
    const centerY = (anchor.y0 + anchor.y1) / 2;
    const colWidth = columnWidths[row.column];
    const answerLeft = Math.min(width - 1, Math.max(anchor.x1 + 2, anchor.x1 + colWidth * 0.08));
    const columnRight = row.column === 0
      ? columnBoundary - colWidth * 0.025
      : Math.min(width - 1, (columnCenters[1] ?? columnBoundary) + colWidth * 2);
    const typeLabels = row.type === "multiple-choice" ? ["MC"]
      : row.type === "true-false" ? ["T/F", "TF"]
        : row.type === "matching" ? ["MATCH", "MATCHING"] : ["ID"];
    const label = words.find((word) => {
      const normalized = word.text.toUpperCase().replace(/[^A-Z/]/g, "");
      return typeLabels.includes(normalized)
        && word.x0 > anchor.x1
        && word.x0 < columnRight
        && Math.abs((word.y0 + word.y1) / 2 - centerY) < rowHeight * 0.65;
    });
    const left = label
      ? Math.max(answerLeft, label.x1 + colWidth * 0.015)
      : answerLeft;
    if (left >= columnRight) return [];
    const answerWidth = row.type === "identification"
      ? columnRight - left
      : Math.min(columnRight - left, Math.max(48, colWidth * 0.24));
    return [[row.questionIndex, {
      left: Math.max(0, Math.floor(left)),
      top: Math.max(0, Math.floor(centerY - rowHeight * 0.55)),
      width: Math.max(1, Math.ceil(answerWidth)),
      height: Math.max(1, Math.ceil(rowHeight * 1.1)),
    }] as const];
  }));
}

async function createAnswerContactSheet(file: File, crops: AnswerCrop[]): Promise<AnswerContactSheet> {
  const scale = 3;
  const padding = 12;
  const cellHeight = Math.max(...crops.map((crop) => crop.region.height)) * scale + padding * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(...crops.map((crop) => crop.region.width)) * scale + padding * 2;
  canvas.height = crops.length * cellHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the answer rows for recognition.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const bitmap = await createImageBitmap(file);
  try {
    crops.forEach((crop, index) => {
      const { left, top, width, height } = crop.region;
      context.drawImage(
        bitmap,
        left,
        top,
        width,
        height,
        padding,
        index * cellHeight + padding,
        width * scale,
        height * scale,
      );
    });
  } finally {
    bitmap.close();
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The answer rows could not be prepared for recognition.");
  return {
    file: new File([blob], "answer-rows.png", { type: "image/png" }),
    crops,
    scale,
    padding,
    cellHeight,
  };
}

function readContactSheetResponses(words: OcrWord[], contactSheet: AnswerContactSheet) {
  const responses = new Map<number, string>();
  contactSheet.crops.forEach((crop, index) => {
    const top = index * contactSheet.cellHeight + contactSheet.padding;
    const bottom = top + crop.region.height * contactSheet.scale;
    const rowWords = words
      .filter((word) => {
        const center = (word.y0 + word.y1) / 2;
        return center >= top && center <= bottom;
      })
      .sort((a, b) => a.x0 - b.x0);
    const response = normalizeScannedResponse(crop.type, rowWords.map((word) => word.text).join(" "));
    if (response) responses.set(crop.questionIndex, response);
  });
  return responses;
}

function getAnswerWhitelist(type: ExamType, matchingChoiceCount: number) {
  if (type === "multiple-choice") return "ABCD";
  if (type === "true-false") return "TRUEFALSE";
  if (type === "matching") {
    return Array.from({ length: Math.min(matchingChoiceCount, 26) }, (_, index) => String.fromCharCode(65 + index)).join("");
  }
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,'-";
}

function normalizeScannedResponse(type: ExamType, text: string) {
  const value = text.toUpperCase().replace(/\s+/g, " ").trim();
  if (type === "multiple-choice") return value.match(/[A-D]/g)?.join("/") ?? "";
  if (type === "true-false") return value.match(/TRUE|FALSE|[TF]/)?.[0] ?? "";
  if (type === "matching") return value.match(/[A-Z]/g)?.join("/") ?? "";
  return value;
}

function parseResponseLines(text: string, fallbackQuestionIndexes?: number[]) {
  const numbered = new Map<number, string>();
  const unnumbered: string[] = [];

  text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const match = line.match(/^\s*(\d{1,3})\s*[.)\]:-]?\s+(.+?)\s*$/);
    const content = (match ? match[2] : line)
      .replace(/^(?:MC\s*A-D|MC|T\s*\/\s*F|True\s*\/\s*False|MATCH(?:ING)?|ID|Answer)\s*:?\s*/i, "")
      .trim();
    if (!content || /^(?:MARKWISE|EXAM BUILDER|ANSWER SHEET|MATCHING CHOICES|STUDENT NAME|DATE|WRITE ONE ANSWER|PAGE\s+\d+)/i.test(content)) return;
    if (!match && /^[A-Z]\.\s+/.test(content)) return;
    if (match) numbered.set(Number(match[1]), content);
    else unnumbered.push(content);
  });

  return (questionIndex: number) => {
    const fallbackIndex = fallbackQuestionIndexes?.indexOf(questionIndex) ?? questionIndex;
    return numbered.get(questionIndex + 1) ?? unnumbered[fallbackIndex] ?? "";
  };
}

function getExpectedAnswer(question: ExamQuestion, exam: SavedExam) {
  if (question.type === "multiple-choice") {
    const choiceIndex = answerLetters.indexOf(question.correctAnswer);
    return choiceIndex >= 0
      ? `${question.correctAnswer}. ${question.choices[choiceIndex] ?? ""}`
      : question.correctAnswer;
  }
  if (question.type === "matching") {
    return exam.matchingChoices.find((choice) => choice === question.correctAnswer) ?? question.correctAnswer;
  }
  return question.correctAnswer;
}

function getRecognizedLabel(question: ExamQuestion, exam: SavedExam, response: string) {
  const value = response.trim().toUpperCase();
  if (!value) return "No answer recognized";
  const selected = value.split("/").filter(Boolean);

  if (question.type === "multiple-choice") {
    const labels = selected.map((label) => {
      const choice = question.choices[answerLetters.indexOf(label)];
      return choice ? `${label}. ${choice}` : label;
    });
    return labels.length > 1 ? `Multiple marks: ${labels.join("; ")}` : labels[0] ?? response;
  }

  if (question.type === "true-false") {
    const labels = selected.map((label) => label === "T" ? "True" : label === "F" ? "False" : label);
    return labels.length > 1 ? `Multiple marks: ${labels.join("; ")}` : labels[0] ?? response;
  }

  if (question.type === "matching") {
    const labels = selected.map((label) => {
      const optionIndex = label.charCodeAt(0) - 65;
      const choice = exam.matchingChoices[optionIndex];
      return choice ? `${label}. ${choice}` : label;
    });
    return labels.length > 1 ? `Multiple marks: ${labels.join("; ")}` : labels[0] ?? response;
  }

  return response;
}

function matchesAnswer(question: ExamQuestion, exam: SavedExam, response: string) {
  const normalizedResponse = normalizeAnswer(response);
  const normalizedExpected = normalizeAnswer(question.correctAnswer);
  if (!normalizedResponse || !normalizedExpected) return false;
  if (response.includes("/")) return false;
  if (normalizedResponse === normalizedExpected) return true;

  if (question.type === "multiple-choice") {
    const selectedLetter = response.trim().match(/^([a-d])(?:\b|[.)\s:-])/i)?.[1]?.toUpperCase();
    if (selectedLetter === question.correctAnswer.toUpperCase()) return true;
    const selectedChoice = question.choices[answerLetters.indexOf(question.correctAnswer)];
    return Boolean(selectedChoice && normalizedResponse === normalizeAnswer(selectedChoice));
  }

  if (question.type === "true-false") {
    const expected = question.correctAnswer.toLowerCase();
    return expected === "true"
      ? /\b(true|t)\b/i.test(response)
      : /\b(false|f)\b/i.test(response);
  }

  if (question.type === "matching") {
    const matchIndex = exam.matchingChoices.indexOf(question.correctAnswer);
    const responseLetter = response.trim().match(/^([a-z])(?:\b|[.)\s:-])/i)?.[1]?.toUpperCase();
    const expectedLetter = matchIndex >= 0 ? String.fromCharCode(65 + matchIndex) : "";
    return Boolean(expectedLetter && responseLetter === expectedLetter)
      || normalizeAnswer(getExpectedAnswer(question, exam)) === normalizedResponse;
  }

  return false;
}

function createResults(exam: SavedExam, responseText: string): AnswerCheckRow[] {
  const responseAt = parseResponseLines(responseText);
  return exam.questions.map((question, index) => {
    const response = responseAt(index);
    return {
      number: index + 1,
      type: question.type,
      response,
      expected: getExpectedAnswer(question, exam),
      status: !response.trim() ? "unanswered" : matchesAnswer(question, exam, response) ? "correct" : "review",
    };
  });
}

export default function AnswerChecker({ exam, onClose }: { exam: SavedExam; onClose: () => void }) {
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [selectedPage, setSelectedPage] = useState(0);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraExpanded, setCameraExpanded] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [readError, setReadError] = useState("");
  const [isReading, setIsReading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<AnswerCheckRow[] | null>(null);
  const answerSheetLayout = createAnswerSheetLayout(exam.questions, exam.matchingChoices);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function setImage(file: File) {
    setPhoto(file);
    setPreviewUrl(URL.createObjectURL(file));
    setResults(null);
    setReadError("");
    setProgress(0);
  }

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    if (file.type.startsWith("image/")) {
      setReadError("");
      setImage(file);
      setResults(null);
    } else {
      setReadError("Choose an image of the answer sheet.");
    }
    input.value = "";
  }

  async function startCamera() {
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Live camera access requires HTTPS and a supported browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      if (!videoRef.current) throw new Error("The camera preview could not be opened.");
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraError(error instanceof Error && error.name === "NotAllowedError"
        ? "Camera permission was blocked. Allow access in browser settings and try again."
        : error instanceof Error ? error.message : "The camera could not be started.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setCameraExpanded(false);
  }

  async function capturePhoto() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError("Wait for the live preview before capturing.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("This browser could not prepare the camera image.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!image) {
      setCameraError("The camera image could not be captured.");
      return;
    }

    stopCamera();
    setImage(new File([image], "student-answers.jpg", { type: "image/jpeg" }));
  }

  async function readPhoto() {
    if (!photo) return;
    setIsReading(true);
    setReadError("");
    setProgress(0);
    let recognizedText = "";
    let cloudOcrWarning = "";
    let cloudOcrAvailable = false;
    let words: OcrWord[] = [];
    let imageWidth = 0;
    let imageHeight = 0;
    let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
    try {
      try {
        setProgress(10);
        const cloudResult = await recognizeWithCloudOcr(photo);
        recognizedText = cloudResult.text;
        words = cloudResult.words;
        imageWidth = cloudResult.width;
        imageHeight = cloudResult.height;
        cloudOcrAvailable = true;
        setProgress(20);
      } catch (cloudError) {
        cloudOcrWarning = cloudError instanceof Error ? cloudError.message : "Cloud handwriting OCR failed.";
        worker = await createWorker("eng", 1, {
          logger: (message) => {
            if (message.status === "recognizing text") setProgress(Math.round(message.progress * 30));
          },
        });
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        const { data } = await worker.recognize(photo, {}, { blocks: true });
        recognizedText = data.text.trim();
        words = getOcrWords(data.blocks);
      }

      const bitmap = await createImageBitmap(photo);
      imageWidth ||= bitmap.width;
      imageHeight ||= bitmap.height;
      bitmap.close();

      const detectedPage = pageIndexFromOcr(recognizedText, answerSheetLayout.pageCount) ?? selectedPage;
      setSelectedPage(detectedPage);
      const answerRegions = getAnswerRegions(words, imageWidth, imageHeight, answerSheetLayout, detectedPage);
      if (answerRegions.size === 0) {
        throw new Error("Could not locate the printed question numbers. Upload a clear photo showing the answer-sheet rows and try again.");
      }

      const previousResponseAt = parseResponseLines(responseText);
      const pageRows = answerSheetLayout.rows.filter((answerRow) => answerRow.page === detectedPage);
      const answerCrops = pageRows.flatMap((row) => {
        const region = answerRegions.get(row.questionIndex);
        return region ? [{ questionIndex: row.questionIndex, type: row.type, region }] : [];
      });
      const contactSheet = await createAnswerContactSheet(photo, answerCrops);
      let scannedResponseAt = new Map<number, string>();
      if (cloudOcrAvailable) {
        try {
          setProgress(60);
          const cloudRows = await recognizeWithCloudOcr(contactSheet.file);
          scannedResponseAt = readContactSheetResponses(cloudRows.words, contactSheet);
          if (scannedResponseAt.size === 0) {
            throw new Error("Cloud handwriting OCR did not recognize any isolated answers.");
          }
        } catch (cloudError) {
          cloudOcrWarning = cloudError instanceof Error
            ? cloudError.message : "Cloud handwriting OCR could not read the isolated answer rows.";
        }
      }

      if (!cloudOcrAvailable || cloudOcrWarning) {
        worker ??= await createWorker("eng", 1, {
          logger: (message) => {
            if (message.status === "recognizing text") {
              setProgress(Math.min(99, 15 + Math.round(message.progress * 75)));
            }
          },
        });
        for (const [rowIndex, crop] of contactSheet.crops.entries()) {
          await worker.setParameters({
            tessedit_pageseg_mode: PSM.SINGLE_LINE,
            tessedit_char_whitelist: getAnswerWhitelist(crop.type, exam.matchingChoices.length),
          });
          const region = {
            left: contactSheet.padding,
            top: rowIndex * contactSheet.cellHeight + contactSheet.padding,
            width: crop.region.width * contactSheet.scale,
            height: crop.region.height * contactSheet.scale,
          };
          const { data } = await worker.recognize(contactSheet.file, { rectangle: region });
          const response = normalizeScannedResponse(crop.type, data.text);
          if (response) scannedResponseAt.set(crop.questionIndex, response);
          setProgress(Math.min(99, 15 + Math.round(((rowIndex + 1) / Math.max(1, contactSheet.crops.length)) * 75)));
        }
      }

      const combinedResponseText = exam.questions.map((question, index) => {
        let response = previousResponseAt(index);
        if (answerSheetLayout.rows[index].page === detectedPage) {
          response = scannedResponseAt.get(index) || response;
        }
        return response.trim() ? `${index + 1}. ${response.trim()}` : "";
      }).filter(Boolean).join("\n");

      setResponseText(combinedResponseText);
      setProgress(100);
      setReadError(cloudOcrWarning
        ? `Cloud OCR unavailable: ${cloudOcrWarning} Local OCR read each answer row. Review responses before grading.`
        : "Each answer was read from its own row. Review responses before grading.");
      setResults(null);
    } catch (error) {
      setReadError(error instanceof Error ? error.message : "The image could not be read.");
    } finally {
      await worker?.terminate();
      setIsReading(false);
    }
  }

  const correctCount = results?.filter((result) => result.status === "correct").length ?? 0;
  const unansweredCount = results?.filter((result) => result.status === "unanswered").length ?? 0;
  const recognizedResponseAt = parseResponseLines(responseText);
  const hasRecognizedResponses = responseText.trim().length > 0;
  const previewRows = exam.questions.map((question, index) => {
    const response = recognizedResponseAt(index);
    return {
      number: index + 1,
      type: typeLabels[question.type],
      label: getRecognizedLabel(question, exam, response),
      hasMark: Boolean(response.trim()),
      multipleMarks: response.includes("/"),
    };
  });
  const detectedCount = previewRows.filter((row) => row.hasMark).length;

  return (
    <div className="answer-check-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        stopCamera();
        onClose();
      }
    }}>
      <section className="answer-check-dialog" role="dialog" aria-modal="true" aria-labelledby="answer-check-title">
        <header className="answer-check-header">
          <div>
            <p className="eyebrow">SAVED EXAM <span> / </span> CHECK RESPONSES</p>
            <h2 id="answer-check-title">{exam.title}</h2>
            <p>{exam.itemCount} items · {exam.typeCounts["multiple-choice"]} MC · {exam.typeCounts["true-false"]} T/F · {exam.typeCounts.identification} ID · {exam.typeCounts.matching} matching</p>
          </div>
          <button className="icon-delete" type="button" onClick={() => {
            stopCamera();
            onClose();
          }} aria-label="Close answer checker">×</button>
        </header>

        <div className="answer-check-content">
          <div className="answer-capture-panel">
            <h3>Student response</h3>
            <p>Scan one page of this exam&apos;s answer-sheet PDF at a time. When configured, images are sent to Google Cloud Vision for handwriting recognition; review all responses before grading.</p>
            <div className={`answer-camera-stage${cameraActive ? " is-live" : ""}${cameraExpanded ? " camera-expanded" : ""}`}>
              <video
                ref={videoRef}
                className={`answer-camera-feed${cameraActive ? " active" : ""}`}
                autoPlay
                muted
                playsInline
                aria-label="Live student answer camera"
              />
              {cameraActive ? (
                <div className="answer-camera-controls">
                  <button className="camera-button" type="button" onClick={capturePhoto}>Capture</button>
                  <button className="camera-expand-button" type="button" onClick={() => setCameraExpanded((expanded) => !expanded)} aria-pressed={cameraExpanded}>
                    {cameraExpanded ? "Collapse" : "Expand"}
                  </button>
                  <button className="camera-cancel" type="button" onClick={stopCamera}>Cancel</button>
                </div>
              ) : previewUrl ? (
                <Image src={previewUrl} alt="Uploaded student answer sheet" width={900} height={600} unoptimized />
              ) : (
                <div className="answer-camera-empty">
                  <span aria-hidden="true">▤</span>
                  <strong>No answer sheet selected</strong>
                  <small>Live camera or image upload</small>
                </div>
              )}
            </div>
            {!cameraActive && (
              <div className="answer-capture-actions">
                <button className="builder-secondary-button" type="button" onClick={() => void startCamera()}>Start live camera</button>
                <input ref={uploadRef} className="file-input" type="file" accept="image/*" onChange={handleUpload} aria-label="Upload a student answer sheet image" />
                <button className="builder-secondary-button" type="button" onClick={() => uploadRef.current?.click()}>Upload image</button>
              </div>
            )}
            {cameraError && <p className="field-error" role="alert">{cameraError}</p>}
            {answerSheetLayout.pageCount > 1 && (
              <label className="builder-field" htmlFor="answer-sheet-page">
                <span>PAGE TO SCAN</span>
                <select id="answer-sheet-page" className="builder-select" value={selectedPage} onChange={(event) => setSelectedPage(Number(event.target.value))}>
                  {Array.from({ length: answerSheetLayout.pageCount }, (_, pageIndex) => (
                    <option value={pageIndex} key={pageIndex}>Page {pageIndex + 1}</option>
                  ))}
                </select>
              </label>
            )}
            {photo && !cameraActive && (
              <button className="answer-read-button" type="button" onClick={() => void readPhoto()} disabled={isReading}>
                {isReading ? `Reading image... ${progress}%` : "Read answer sheet and OCR"}
              </button>
            )}
            {readError && <p className="field-error" role="alert">{readError}</p>}
          </div>

          <div className="answer-response-panel">
            <label className="builder-field" htmlFor="recognized-answers">
              <span>RESPONSES / MANUAL CORRECTIONS</span>
              <textarea
                id="recognized-answers"
                className="builder-textarea recognized-answers"
                value={responseText}
                onChange={(event) => {
                  setResponseText(event.target.value);
                  setResults(null);
                }}
                placeholder={"Enter one answer per line, for example:\n1. B\n2. True\n3. Water"}
              />
            </label>
            <p className="answer-check-note">The sheet is reviewed for written responses and OCR-based identification; confirm each answer before grading.</p>
            {hasRecognizedResponses && (
              <section className="recognized-preview" aria-live="polite">
                <header className="recognized-preview-heading">
                  <div>
                    <h3>Scan preview</h3>
                    <p>{detectedCount} of {exam.questions.length} responses detected</p>
                  </div>
                </header>
                <div className="recognized-preview-table">
                  <div className="recognized-preview-row recognized-preview-head"><span>ITEM</span><span>DETECTED RESPONSE</span><span>SCAN</span></div>
                  {previewRows.map((row) => (
                    <div className="recognized-preview-row" key={row.number}>
                      <span>{String(row.number).padStart(2, "0")} · {row.type}</span>
                      <span>{row.label}</span>
                      <span className={`recognized-preview-status${row.multipleMarks ? " needs-review" : ""}`}>
                        {row.multipleMarks ? "Multiple" : row.hasMark ? "Detected" : "Blank"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <button className="text-action text-danger" type="button" onClick={() => {
              setResponseText("");
              setResults(null);
            }}>Clear responses</button>
            <button className="builder-primary-button answer-grade-button" type="button" onClick={() => setResults(createResults(exam, responseText))} disabled={!hasRecognizedResponses}>
              Check preview against answer key <span aria-hidden="true">↗</span>
            </button>
          </div>
        </div>

        {results && (
          <section className="answer-results" aria-live="polite">
            <header className="answer-results-header">
              <div>
                <h3>Answer check</h3>
                <p>{correctCount} of {results.length} marked correct · {unansweredCount} unanswered</p>
              </div>
              <button className="builder-secondary-button" type="button" onClick={() => setResults(null)}>Clear results</button>
            </header>
            <div className="answer-results-table">
              <div className="answer-results-row answer-results-head"><span>ITEM</span><span>RESPONSE</span><span>ANSWER KEY</span><span>CHECK</span></div>
              {results.map((result) => (
                <div className="answer-results-row" key={result.number}>
                  <span>{String(result.number).padStart(2, "0")} · {typeLabels[result.type]}</span>
                  <span>{result.response || "—"}</span>
                  <span>{result.expected}</span>
                  <span className={`answer-status ${result.status}`}>
                    {result.status === "correct" ? "Correct" : result.status === "unanswered" ? "Unanswered" : "Review"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>
    </div>
  );
}

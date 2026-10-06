'use client';

import Link from "next/link";
import * as pdfjsLib from "pdfjs-dist";
import { createWorker } from "tesseract.js";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { jsPDF as JsPDFDocument } from "jspdf";
import AnswerChecker from "./answer-checker";
import { createMatchingChoiceRows } from "./answer-sheet-omr";
import { answerSheetPageHeight, answerSheetPageWidth, createAnswerSheetLayout } from "./answer-sheet-omr";
import { validateExamDraft } from "@/app/lib/exam-validation";
import { examTypes, normalizeExamDraft, type ExamDraft, type ExamQuestion, type ExamType, type ExamTypeCounts, type SavedExam, type ValidationIssue } from "@/app/lib/exam-types";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const examTypeLabels: Record<ExamType, string> = {
  "multiple-choice": "Multiple Choice",
  "true-false": "True or False",
  identification: "Identification",
  matching: "Matching Type",
};

const choiceLetters = ["A", "B", "C", "D"];
const defaultTypeCounts: ExamTypeCounts = {
  "multiple-choice": 10,
  "true-false": 0,
  identification: 0,
  matching: 0,
};

function createQuestion(type: ExamType): ExamQuestion {
  return {
    id: crypto.randomUUID(),
    type,
    prompt: "",
    choices: type === "multiple-choice" ? ["", "", "", ""] : [],
    correctAnswer: "",
  };
}

function getExamTypeLabel(type: ExamType) {
  return examTypeLabels[type];
}

function sumTypeCounts(counts: ExamTypeCounts) {
  return examTypes.reduce((total, type) => total + counts[type], 0);
}

function describeTypeCounts(counts: ExamTypeCounts) {
  return examTypes
    .filter((type) => counts[type] > 0)
    .map((type) => `${getExamTypeLabel(type)} ${counts[type]}`)
    .join(" · ");
}

function answerLabel(question: ExamQuestion, matchingChoices: string[]) {
  if (question.type === "multiple-choice") {
    const index = choiceLetters.indexOf(question.correctAnswer);
    return index >= 0 ? `${question.correctAnswer}. ${question.choices[index]}` : question.correctAnswer;
  }
  if (question.type === "matching") return matchingChoices.find((choice) => choice === question.correctAnswer) ?? question.correctAnswer;
  return question.correctAnswer;
}

async function recognizeDocumentText(file: File, onProgress: (progress: number) => void) {
  const fileName = file.name.toLowerCase();

  if (file.type === "application/pdf" || fileName.endsWith(".pdf")) {
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let content = "";
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const pageText = await page.getTextContent();
      const text = pageText.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      content += `${text}\n`;
      onProgress(Math.round((pageNumber / pdf.numPages) * 100));
    }
    if (!content.trim()) throw new Error("No readable text was found in this PDF.");
    return content.trim();
  }

  if (file.type.startsWith("image/") || [".png", ".jpg", ".jpeg", ".bmp", ".webp"].some((extension) => fileName.endsWith(extension))) {
    const worker = await createWorker("eng", 1, {
      logger: (message) => {
        if (message.status === "recognizing text") {
          onProgress(Math.round(message.progress * 100));
        }
      },
    });

    try {
      const { data } = await worker.recognize(file);
      if (!data.text.trim()) throw new Error("No text could be read from the uploaded image.");
      return data.text.trim();
    } finally {
      await worker.terminate();
    }
  }

  if (file.type.includes("text") || fileName.endsWith(".txt")) {
    const text = await file.text();
    if (!text.trim()) throw new Error("This text file is empty.");
    return text.trim();
  }

  throw new Error("Upload a PDF, image, or text file to scan an exam.");
}

function parseImportedExamDocument(rawText: string): Partial<ExamDraft> | null {
  const lines = rawText
    .replace(/\r/g, "")
    .replace(/[\u00A0]/g, " ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:answer\s*key|key|page\s+\d+|page\s*\d+\s*of\s*\d+)$/i.test(line));

  if (lines.length === 0) return null;

  const questionStartPattern = /^(?:question\s*)?(?:q\s*)?(\d+)[\).\]:-]|^\d+[\).]\s+/i;
  const firstQuestionIndex = lines.findIndex((line) => questionStartPattern.test(line));

  const title = firstQuestionIndex > 0
    ? lines.slice(0, firstQuestionIndex).filter((line) => !/^(?:teacher|subject|course|date|section|instructions?|answer\s*key|key)$/i.test(line)).join(" ").trim()
    : "Imported Exam";

  const questionLines = firstQuestionIndex >= 0 ? lines.slice(firstQuestionIndex) : lines;
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of questionLines) {
    const startsQuestion = questionStartPattern.test(line);
    if (startsQuestion && current.length > 0) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);

  if (blocks.length === 0) return null;

  const questions: ExamQuestion[] = [];
  const matchingChoices = new Set<string>();
  const typeCounts = { "multiple-choice": 0, "true-false": 0, identification: 0, matching: 0 } as ExamTypeCounts;

  blocks.forEach((block, blockIndex) => {
    const blockText = block.join(" ").replace(/\s+/g, " ").trim();
    if (!blockText) return;

    const rawPromptLines = block
      .map((line) => line.replace(/^(?:question\s*)?(?:q\s*)?(?:\d+)[\).\]:-]\s*/i, "").trim())
      .filter((line) => line.length > 0);

    const optionMatches = rawPromptLines.flatMap((line) => {
      const match = line.match(/^([A-D]|[1-4])[\).\-:]\s*(.+)$/i);
      return match ? [{ label: match[1].toUpperCase(), value: match[2].trim() }] : [];
    });

    const textOnlyLines = rawPromptLines.filter((line) => !/^([A-D]|[1-4])[\).\-:]\s+/.test(line));
    const promptText = textOnlyLines.join(" ").trim();

    const valueText = optionMatches.map((entry) => entry.value).join(" ");
    const isMatching = /match(?:ing)?\b|\bpair\s+the\b|\bcolumn\s+[a-z]\b/i.test(blockText)
      || (optionMatches.length >= 2 && /\b(?:dog|cat|bird|fish|apple|banana|red|blue|country|city)\b/i.test(valueText));
    const isTrueFalse = !isMatching && (
      /\btrue\b.*\bfalse\b|\bfalse\b.*\btrue\b|\btrue\s*\/\s*false\b|\btrue\s*or\s*false\b/i.test(blockText)
      || (optionMatches.length >= 2 && optionMatches.every((entry) => /^(true|false)$/i.test(entry.value.trim())))
    );
    const isMultipleChoice = !isMatching && !isTrueFalse && optionMatches.length >= 2;

    const type: ExamType = isMatching ? "matching" : isTrueFalse ? "true-false" : isMultipleChoice ? "multiple-choice" : "identification";

    const choices = optionMatches.map((entry) => entry.value)
      .filter((value) => value && value.length > 0)
      .slice(0, 4);

    const prompt = promptText || blockText.replace(/(?:^|\s)(?:[A-D]|[1-4])[\).\-:]\s*[^A-D]+/gi, "").replace(/\s{2,}/g, " ").trim() || `Imported question ${blockIndex + 1}`;

    const question: ExamQuestion = {
      id: `imported-question-${blockIndex + 1}`,
      type,
      prompt,
      choices: type === "multiple-choice" ? (choices.length >= 2 ? choices : ["", "", "", ""]) : type === "true-false" ? ["True", "False"] : [],
      correctAnswer: "",
    };

    if (type === "matching") {
      choices.forEach((choice) => {
        if (choice.trim()) matchingChoices.add(choice.trim());
      });
    }

    questions.push(question);
    typeCounts[question.type] += 1;
  });

  if (questions.length === 0) return null;

  return {
    title: title.replace(/^[-•*\s]+|[-•*\s]+$/g, "").trim() || "Imported Exam",
    typeCounts,
    itemCount: questions.length,
    instructions: "Imported from document scan. Review each question and save when ready.",
    matchingChoices: [...matchingChoices].slice(0, 8).length > 0 ? [...matchingChoices].slice(0, 8) : ["", ""],
    questions,
  };
}

function drawLongPaperHeader(pdf: JsPDFDocument, examTitle: string, documentTitle: string, typeSummary: string) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 16;
  pdf.setFillColor(23, 98, 77);
  pdf.rect(0, 0, pageWidth, 30, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8);
  pdf.text("MARKWISE  /  EXAM BUILDER", margin, 10);
  pdf.setFont("times", "bold");
  pdf.setFontSize(19);
  pdf.text(documentTitle, margin, 23);

  pdf.setTextColor(23, 44, 37);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(12);
  pdf.text(examTitle, margin, 41, { maxWidth: pageWidth - margin * 2 });
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  pdf.setTextColor(102, 118, 110);
  pdf.text(`${typeSummary} · ${examTitle ? "Long bond · 8.5 × 13 in" : "Long bond · 8.5 x 13 in"}`, margin, 49);
}

export default function ExamBuilderPage() {
  const [title, setTitle] = useState("");
  const [itemCount, setItemCount] = useState("10");
  const [typeCounts, setTypeCounts] = useState<ExamTypeCounts>(defaultTypeCounts);
  const [preparedTypeCounts, setPreparedTypeCounts] = useState<ExamTypeCounts>(defaultTypeCounts);
  const [preparedCount, setPreparedCount] = useState(0);
  const [setupStep, setSetupStep] = useState<1 | 2 | 3>(1);
  const [formStarted, setFormStarted] = useState(false);
  const [questions, setQuestions] = useState<ExamQuestion[]>([]);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [matchingChoices, setMatchingChoices] = useState<string[]>(["", ""]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [formMessage, setFormMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editingExamId, setEditingExamId] = useState<string | null>(null);
  const [previewDraft, setPreviewDraft] = useState<ExamDraft | null>(null);
  const [previewSavedExamId, setPreviewSavedExamId] = useState<string | null>(null);
  const [savedExams, setSavedExams] = useState<SavedExam[]>([]);
  const [checkingExam, setCheckingExam] = useState<SavedExam | null>(null);
  const [isLoadingExams, setIsLoadingExams] = useState(true);
  const [savedListError, setSavedListError] = useState("");
  const [examPackageMessage, setExamPackageMessage] = useState("");
  const [documentImportMessage, setDocumentImportMessage] = useState("");
  const [isImportingDocument, setIsImportingDocument] = useState(false);
  const [documentImportProgress, setDocumentImportProgress] = useState(0);
  const examPackageInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/exams")
      .then(async (response) => {
        if (!response.ok) throw new Error("Saved exams could not be loaded.");
        return response.json() as Promise<{ exams: SavedExam[] }>;
      })
      .then((data) => {
        if (active) setSavedExams(data.exams);
      })
      .catch((error: unknown) => {
        if (active) setSavedListError(error instanceof Error ? error.message : "Saved exams could not be loaded.");
      })
      .finally(() => {
        if (active) setIsLoadingExams(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function currentDraft(): ExamDraft {
    return {
      title,
      typeCounts: preparedTypeCounts,
      itemCount: preparedCount,
      instructions,
      matchingChoices,
      questions,
    };
  }

  async function handleExamPackageUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setExamPackageMessage("");
    try {
      const extension = file.name.toLowerCase().split(".").pop();
      if (extension !== "json") {
        throw new Error("Choose a Markwise .json package.");
      }

      const parsed: unknown = JSON.parse(await file.text());
      const envelope = typeof parsed === "object" && parsed !== null
        ? parsed as Record<string, unknown>
        : {};
      if (envelope.format && envelope.format !== "markwise-exam-package") {
        throw new Error("This file is not a Markwise exam package.");
      }
      if (envelope.format === "markwise-exam-package" && envelope.version !== 1) {
        throw new Error("This exam package version is not supported.");
      }
      const draft = normalizeExamDraft(envelope.format === "markwise-exam-package" ? envelope.exam : parsed);

      const validationIssues = validateExamDraft(draft);
      if (validationIssues.length > 0) {
        throw new Error(`The file is incomplete: ${validationIssues.map((issue) => issue.message).join(" ")}`);
      }

      setTitle(draft.title);
      setItemCount(String(draft.itemCount));
      setTypeCounts({ ...draft.typeCounts });
      setPreparedTypeCounts({ ...draft.typeCounts });
      setPreparedCount(draft.itemCount);
      setQuestions(draft.questions);
      setInstructions(draft.instructions);
      setMatchingChoices(draft.matchingChoices);
      setActiveQuestionId(draft.questions.find((question) => !question.prompt.trim())?.id ?? draft.questions[0]?.id ?? null);
      setEditingExamId(null);
      setFormStarted(true);
      setSetupStep(3);
      setIssues([]);
      setFormMessage("");
      setPreviewDraft(null);
      setPreviewSavedExamId(null);
      setExamPackageMessage(`Imported “${draft.title}” with its answer key. Save it to add it to Saved exams.`);
    } catch (error) {
      setExamPackageMessage(error instanceof Error ? error.message : "This exam file could not be imported.");
    } finally {
      input.value = "";
    }
  }

  async function handleExamDocumentImport(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setDocumentImportMessage("");
    setIsImportingDocument(true);
    setDocumentImportProgress(0);
    try {
      const text = await recognizeDocumentText(file, setDocumentImportProgress);
      const draft = parseImportedExamDocument(text);
      if (!draft || draft.questions?.length === 0) {
        throw new Error("The document could not be read as an exam. Try a clearer image or a text file with numbered questions.");
      }

      const normalizedDraft = normalizeExamDraft(draft);
      setTitle(normalizedDraft.title || "Imported Exam");
      setItemCount(String(normalizedDraft.itemCount));
      setTypeCounts({ ...normalizedDraft.typeCounts });
      setPreparedTypeCounts({ ...normalizedDraft.typeCounts });
      setPreparedCount(normalizedDraft.itemCount);
      setQuestions(normalizedDraft.questions);
      setInstructions(normalizedDraft.instructions);
      setMatchingChoices(normalizedDraft.matchingChoices.length > 0 ? normalizedDraft.matchingChoices : ["", ""]);
      setActiveQuestionId(normalizedDraft.questions[0]?.id ?? null);
      setFormStarted(true);
      setSetupStep(3);
      setIssues([]);
      setPreviewDraft(normalizedDraft);
      setPreviewSavedExamId(null);
      setFormMessage("Imported document loaded into the builder. Review each question and complete any missing answers before saving.");
      setDocumentImportMessage(`Imported “${normalizedDraft.title || "exam"}” and filled the builder. Review the preview and save when ready.`);
    } catch (error) {
      setDocumentImportMessage(error instanceof Error ? error.message : "The document could not be imported.");
    } finally {
      setIsImportingDocument(false);
      setDocumentImportProgress(0);
      input.value = "";
    }
  }

  function downloadExamPackage() {
    if (!formStarted || !validateCurrentDraft()) return;
    const packageContents = {
      format: "markwise-exam-package",
      version: 1,
      exam: currentDraft(),
    };
    const blob = new Blob([JSON.stringify(packageContents, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exam"}-with-answer-key.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function beginQuestionSetup() {
    const nextCount = Number(itemCount);
    const setupIssues: ValidationIssue[] = [];
    if (!title.trim()) setupIssues.push({ field: "title", message: "Enter an exam title." });
    if (!Number.isInteger(nextCount) || nextCount < 1 || nextCount > 100) {
      setupIssues.push({ field: "itemCount", message: "Item count must be a whole number from 1 to 100." });
    }
    setIssues(setupIssues);
    setFormMessage("");
    if (setupIssues.length > 0) return;

    const currentAllocation = sumTypeCounts(typeCounts);
    const nextTypeCounts = currentAllocation === nextCount
      ? { ...typeCounts }
      : { ...defaultTypeCounts, "multiple-choice": nextCount };
    setTypeCounts(nextTypeCounts);
    setPreparedTypeCounts(nextTypeCounts);
    setPreparedCount(nextCount);
    setSetupStep(2);
  }

  function createQuestionSlots() {
    const total = sumTypeCounts(typeCounts);
    if (total !== preparedCount || total < 1 || total > 100) {
      setIssues([{ field: "typeCounts", message: `Per-type counts must add up to ${preparedCount} items. Currently: ${total}.` }]);
      return;
    }

    const nextQuestions = examTypes.flatMap((type) => {
      const existing = questions.filter((question) => question.type === type).slice(0, typeCounts[type]);
      while (existing.length < typeCounts[type]) existing.push(createQuestion(type));
      return existing;
    });
    setQuestions(nextQuestions);
    setPreparedTypeCounts({ ...typeCounts });
    setPreparedCount(total);
    setActiveQuestionId(nextQuestions.find((question) => !question.prompt.trim())?.id ?? nextQuestions[0]?.id ?? null);
    setIssues([]);
    setFormStarted(true);
    setSetupStep(3);
  }

  function editSetup() {
    setItemCount(String(preparedCount));
    setTypeCounts({ ...preparedTypeCounts });
    setFormStarted(false);
    setSetupStep(1);
    setIssues([]);
    setFormMessage("");
  }

  function updateQuestion(questionId: string, update: Partial<ExamQuestion>) {
    setQuestions((current) => current.map((question) =>
      question.id === questionId ? { ...question, ...update } : question,
    ));
    setIssues((current) => current.filter((issue) => !issue.field.startsWith(`questions.${questions.findIndex((question) => question.id === questionId)}.`)));
  }

  function addQuestion(type: ExamType) {
    if (questions.filter((question) => question.type === type).length >= preparedTypeCounts[type]) return;
    const question = createQuestion(type);
    setQuestions((current) => [...current, question]);
    setActiveQuestionId(question.id);
    setFormMessage("");
  }

  function deleteQuestion(questionId: string) {
    const nextQuestions = questions.filter((question) => question.id !== questionId);
    setQuestions(nextQuestions);
    if (activeQuestionId === questionId) setActiveQuestionId(nextQuestions[0]?.id ?? null);
    setIssues([]);
    setFormMessage("");
  }

  function updateMatchingChoice(index: number, nextValue: string) {
    const previousValue = matchingChoices[index];
    setMatchingChoices((current) => current.map((choice, choiceIndex) => choiceIndex === index ? nextValue : choice));
    if (previousValue.trim()) {
      setQuestions((current) => current.map((question) => question.correctAnswer === previousValue
        ? { ...question, correctAnswer: nextValue }
        : question,
      ));
    }
  }

  function addMatchingChoice() {
    setMatchingChoices((current) => [...current, ""]);
  }

  function deleteMatchingChoice(index: number) {
    const removedChoice = matchingChoices[index];
    setMatchingChoices((current) => current.filter((_, choiceIndex) => choiceIndex !== index));
    if (removedChoice.trim()) {
      setQuestions((current) => current.map((question) => question.correctAnswer === removedChoice
        ? { ...question, correctAnswer: "" }
        : question,
      ));
    }
  }

  function validateCurrentDraft() {
    const nextIssues = validateExamDraft(currentDraft());
    setIssues(nextIssues);
    setFormMessage(nextIssues.length > 0 ? "Complete the highlighted fields before continuing." : "");
    return nextIssues.length === 0;
  }

  function handlePreview() {
    if (!validateCurrentDraft()) return;
    setPreviewDraft(currentDraft());
    setPreviewSavedExamId(null);
  }

  function viewSavedExam(exam: SavedExam) {
    setPreviewDraft(exam);
    setPreviewSavedExamId(exam.id);
  }

  async function refreshSavedExams() {
    const response = await fetch("/api/exams");
    const data = await response.json() as { exams?: SavedExam[]; error?: string };
    if (!response.ok || !data.exams) throw new Error(data.error ?? "Saved exams could not be loaded.");
    setSavedExams(data.exams);
    setSavedListError("");
  }

  async function saveExam() {
    if (!validateCurrentDraft()) return;
    setIsSaving(true);
    setFormMessage("");
    try {
      const response = await fetch(editingExamId ? `/api/exams/${editingExamId}` : "/api/exams", {
        method: editingExamId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentDraft()),
      });
      const data = await response.json() as { exam?: SavedExam; error?: string; issues?: ValidationIssue[] };
      if (!response.ok || !data.exam) {
        setIssues(data.issues ?? []);
        throw new Error(data.error ?? "The exam could not be saved.");
      }
      setEditingExamId(data.exam.id);
      setFormMessage("Exam saved. It is available in your saved exams list.");
      await refreshSavedExams();
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : "The exam could not be saved.");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadExam(examId: string) {
    setFormMessage("");
    try {
      const response = await fetch(`/api/exams/${examId}`);
      const data = await response.json() as { exam?: SavedExam; error?: string };
      if (!response.ok || !data.exam) throw new Error(data.error ?? "The exam could not be loaded.");
      const exam = normalizeExamDraft(data.exam);
      setTitle(exam.title);
      setItemCount(String(exam.itemCount));
      setTypeCounts({ ...exam.typeCounts });
      setPreparedTypeCounts({ ...exam.typeCounts });
      setPreparedCount(exam.itemCount);
      setFormStarted(true);
      setSetupStep(3);
      setQuestions(exam.questions);
      setInstructions(exam.instructions);
      setMatchingChoices(exam.matchingChoices);
      setActiveQuestionId(null);
      setEditingExamId(data.exam.id);
      setIssues([]);
      setPreviewDraft(null);
      setPreviewSavedExamId(null);
      setFormMessage(`Editing “${exam.title}”.`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setSavedListError(error instanceof Error ? error.message : "The exam could not be loaded.");
    }
  }

  async function removeExam(examId: string, examTitle: string) {
    if (!window.confirm(`Delete “${examTitle}” permanently?`)) return;
    try {
      const response = await fetch(`/api/exams/${examId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("The exam could not be deleted.");
      setSavedExams((current) => current.filter((exam) => exam.id !== examId));
      if (editingExamId === examId) {
        setEditingExamId(null);
        setFormStarted(false);
        setSetupStep(1);
      }
      setSavedListError("");
    } catch (error) {
      setSavedListError(error instanceof Error ? error.message : "The exam could not be deleted.");
    }
  }

  function startNewExam() {
    setTitle("");
    setItemCount("10");
    setTypeCounts({ ...defaultTypeCounts });
    setPreparedTypeCounts({ ...defaultTypeCounts });
    setPreparedCount(0);
    setFormStarted(false);
    setSetupStep(1);
    setQuestions([]);
    setInstructions("");
    setMatchingChoices(["", ""]);
    setActiveQuestionId(null);
    setEditingExamId(null);
    setIssues([]);
    setFormMessage("");
    setPreviewDraft(null);
    setPreviewSavedExamId(null);
  }

  async function downloadAnswerSheetPdf(exam: ExamDraft) {
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ unit: "mm", format: [answerSheetPageWidth, answerSheetPageHeight] });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 16;
    const layout = createAnswerSheetLayout(exam.questions, exam.matchingChoices);

    function startPage() {
      drawLongPaperHeader(pdf, exam.title, "Answer Sheet", `${exam.itemCount} items`);
      pdf.setTextColor(23, 44, 37);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.text("Student name:", margin, 62);
      pdf.line(margin + 24, 63, 126, 63);
      pdf.text("Date:", 143, 62);
      pdf.line(155, 63, pageWidth - margin, 63);
      pdf.setFontSize(7);
      pdf.text("Write one answer on each line. Use the option letter for MC and matching; write True or False for T/F.", margin, 73);
      if (pdf.getNumberOfPages() === 1 && exam.questions.some((question) => question.type === "matching")) {
        pdf.setFont("helvetica", "bold");
        pdf.text("MATCHING CHOICES", margin, 82);
        let choiceY = 88;
        createMatchingChoiceRows(exam.matchingChoices).forEach((choiceRow) => {
          choiceRow.entries.forEach((entry, entryIndex) => {
            const x = entryIndex === 0 ? margin : pageWidth / 2 + 2;
            pdf.setFont("helvetica", "bold");
            pdf.text(`${entry.label}.`, x, choiceY);
            pdf.setFont("helvetica", "normal");
            entry.lines.forEach((line, lineIndex) => {
              pdf.text(line, x + 7, choiceY + lineIndex * 3.5);
            });
          });
          choiceY += choiceRow.height;
        });
      }
    }

    startPage();
    layout.rows.forEach((row) => {
      while (pdf.getNumberOfPages() <= row.page) {
        pdf.addPage();
        startPage();
      }
      const question = exam.questions[row.questionIndex];
      pdf.setTextColor(23, 44, 37);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.text(String(row.questionIndex + 1).padStart(2, "0"), margin + 1, row.y + 3);

      if (question.type === "identification") {
        pdf.setDrawColor(151, 166, 154);
        pdf.line(margin + 38, row.y + 6, pageWidth - margin, row.y + 6);
        return;
      }

      const answerPrompt = question.type === "multiple-choice"
        ? "Option (A-D):"
        : question.type === "true-false" ? "True / False:" : "Choice letter:";
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.text(answerPrompt, margin + 27, row.y + 4);
      pdf.setDrawColor(95, 119, 104);
      pdf.line(margin + 59, row.y + 6, pageWidth - margin, row.y + 6);
    });

    const pageCount = layout.pageCount;
    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
      pdf.setPage(pageIndex);
      pdf.setTextColor(102, 118, 110);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.text(`Page ${pageIndex} of ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
    }

    const slug = exam.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exam";
    pdf.save(`${slug}-answer-sheet-long-bond.pdf`);
  }

  async function downloadAnswerKeyPdf(exam: ExamDraft) {
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ unit: "mm", format: [215.9, 330.2] });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 16;
    const bottom = pageHeight - 17;
    let y = 62;

    function startPage() {
      drawLongPaperHeader(pdf, exam.title, "Answer Key", `${exam.itemCount} items · ${describeTypeCounts(exam.typeCounts)}`);
      y = 62;
    }

    function writeAnswer(question: ExamQuestion, questionNumber: number) {
      if (y + 20 > bottom) {
        pdf.addPage();
        startPage();
      }

      const answerPrompt = question.type === "multiple-choice" ? "MC A-D:"
        : question.type === "true-false" ? "T/F:"
          : question.type === "matching" ? "Match:"
            : "ID:";

      pdf.setTextColor(39, 85, 66);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.text(`${String(questionNumber).padStart(2, "0")}. ${answerPrompt}`, margin + 1, y);

      const answerText = question.type === "multiple-choice"
        ? question.correctAnswer || "No answer set"
        : question.type === "matching"
          ? question.correctAnswer || "No answer set"
          : question.correctAnswer || "No answer set";

      const wrapped = pdf.splitTextToSize(answerText, pageWidth - margin * 2 - 12) as string[];
      const answerHeight = wrapped.length * 5 + 4;
      if (y + answerHeight > bottom) {
        pdf.addPage();
        startPage();
      }

      pdf.setTextColor(23, 44, 37);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.text(wrapped, margin + 3, y + 6);
      y += answerHeight + 10;
    }

    startPage();
    exam.questions.forEach((question, index) => {
      writeAnswer(question, index + 1);
    });

    const slug = exam.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "exam";
    pdf.save(`${slug}-answer-key-long-bond.pdf`);
  }

  function renderQuestionEditor(question: ExamQuestion, index: number) {
    const questionIssues = issues.filter((issue) => issue.field.startsWith(`questions.${index}.`));
    const choiceIssue = questionIssues.find((issue) => issue.field.endsWith(".choices"));
    const answerIssue = questionIssues.find((issue) => issue.field.endsWith(".correctAnswer"));
    const promptIssue = questionIssues.find((issue) => issue.field.endsWith(".prompt"));
    const isOpen = activeQuestionId === question.id;

    return (
      <article className={`builder-question${questionIssues.length > 0 ? " has-issues" : ""}`} key={question.id}>
        <header className="builder-question-head">
          <div className="builder-question-title">
            <span className="builder-q-number">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>Question {index + 1}</h3>
              <p>{question.prompt.trim() || "No question text yet"}</p>
            </div>
          </div>
          <div className="builder-question-actions">
            <button className="text-action" type="button" onClick={() => setActiveQuestionId(isOpen ? null : question.id)}>
              {isOpen ? "Close" : "Edit"}
            </button>
            <button className="text-action text-danger" type="button" onClick={() => deleteQuestion(question.id)}>
              Delete
            </button>
          </div>
        </header>

        {isOpen && (
          <div className="builder-question-body">
            <label className="builder-label" htmlFor={`prompt-${question.id}`}>QUESTION</label>
            <textarea
              id={`prompt-${question.id}`}
              className="builder-textarea"
              value={question.prompt}
              maxLength={1000}
              onChange={(event) => updateQuestion(question.id, { prompt: event.target.value })}
              placeholder="Write the question prompt..."
            />
            {promptIssue && <p className="field-error">{promptIssue.message}</p>}

            {question.type === "multiple-choice" && (
              <>
                <div className="builder-choice-grid">
                  {choiceLetters.map((letter, choiceIndex) => (
                    <label className="builder-field" htmlFor={`choice-${question.id}-${letter}`} key={letter}>
                      <span>CHOICE {letter}</span>
                      <input
                        id={`choice-${question.id}-${letter}`}
                        className="builder-input"
                        value={question.choices[choiceIndex] ?? ""}
                        maxLength={300}
                        onChange={(event) => {
                          const choices = [...question.choices];
                          choices[choiceIndex] = event.target.value;
                          updateQuestion(question.id, { choices });
                        }}
                        placeholder={`Enter choice ${letter}`}
                      />
                    </label>
                  ))}
                </div>
                {choiceIssue && <p className="field-error">{choiceIssue.message}</p>}
                <label className="builder-field answer-field" htmlFor={`answer-${question.id}`}>
                  <span>CORRECT ANSWER</span>
                  <select
                    id={`answer-${question.id}`}
                    className="builder-select"
                    value={question.correctAnswer}
                    onChange={(event) => updateQuestion(question.id, { correctAnswer: event.target.value })}
                  >
                    <option value="">Select the correct choice</option>
                    {choiceLetters.map((letter, choiceIndex) => (
                      <option value={letter} key={letter}>{letter}{question.choices[choiceIndex]?.trim() ? ` · ${question.choices[choiceIndex]}` : ""}</option>
                    ))}
                  </select>
                </label>
                {answerIssue && <p className="field-error">{answerIssue.message}</p>}
              </>
            )}

            {question.type === "true-false" && (
              <>
                <label className="builder-field answer-field" htmlFor={`answer-${question.id}`}>
                  <span>CORRECT ANSWER</span>
                  <select
                    id={`answer-${question.id}`}
                    className="builder-select"
                    value={question.correctAnswer}
                    onChange={(event) => updateQuestion(question.id, { correctAnswer: event.target.value })}
                  >
                    <option value="">Choose an answer</option>
                    <option value="True">True</option>
                    <option value="False">False</option>
                  </select>
                </label>
                {answerIssue && <p className="field-error">{answerIssue.message}</p>}
              </>
            )}

            {question.type === "identification" && (
              <>
                <label className="builder-field answer-field" htmlFor={`answer-${question.id}`}>
                  <span>CORRECT ANSWER</span>
                  <input
                    id={`answer-${question.id}`}
                    className="builder-input"
                    value={question.correctAnswer}
                    maxLength={500}
                    onChange={(event) => updateQuestion(question.id, { correctAnswer: event.target.value })}
                    placeholder="Enter the expected answer"
                  />
                </label>
                {answerIssue && <p className="field-error">{answerIssue.message}</p>}
              </>
            )}

            {question.type === "matching" && (
              <>
                <label className="builder-field answer-field" htmlFor={`answer-${question.id}`}>
                  <span>CORRECT MATCH</span>
                  <select
                    id={`answer-${question.id}`}
                    className="builder-select"
                    value={question.correctAnswer}
                    onChange={(event) => updateQuestion(question.id, { correctAnswer: event.target.value })}
                  >
                    <option value="">Select a matching choice</option>
                    {matchingChoices.filter((choice) => choice.trim()).map((choice, choiceIndex) => (
                      <option value={choice} key={`${choice}-${choiceIndex}`}>{choice}</option>
                    ))}
                  </select>
                </label>
                {answerIssue && <p className="field-error">{answerIssue.message}</p>}
              </>
            )}
          </div>
        )}
      </article>
    );
  }

  return (
    <main className="exam-builder-page">
      <header className="topbar builder-topbar">
        <Link className="brand" href="/" aria-label="Markwise home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>markwise</span>
        </Link>
        <Link className="builder-back-link" href="/">Back to checker</Link>
      </header>

      <div className="builder-content">
        <section className="builder-heading">
          <p className="eyebrow">EXAM TOOLS <span> / </span> BUILDER</p>
          <h1>Create an exam</h1>
          <p>Write the questions, set the answers, preview, and save a printable exam with its answer key.</p>
        </section>

        <div className="builder-layout">
          <section className="builder-main" aria-label="Exam builder form">
            <div className="builder-panel-heading">
              <div>
                <h2>{formStarted ? "Exam setup" : setupStep === 1 ? "Exam details" : "Choose exam type"}</h2>
                <p>{formStarted ? "Your exam is ready for editing." : setupStep === 1 ? "Start with a title and total item count." : "Choose the format for all questions in this exam."}</p>
              </div>
              <div className="builder-package-actions">
                {editingExamId && <span className="editing-indicator">EDITING SAVED EXAM</span>}
                <input
                  ref={documentInputRef}
                  className="file-input"
                  type="file"
                  accept=".pdf,image/*,.txt,.doc,.docx"
                  onChange={handleExamDocumentImport}
                  aria-label="Upload a scanned exam document or image"
                />
                <button className="builder-secondary-button" type="button" onClick={() => documentInputRef.current?.click()} disabled={isImportingDocument}>
                  {isImportingDocument ? `Scanning... ${documentImportProgress}%` : "Scan exam document"}
                </button>
                <input
                  ref={examPackageInputRef}
                  className="file-input"
                  type="file"
                  accept=".json,application/json"
                  onChange={handleExamPackageUpload}
                  aria-label="Upload a Markwise exam package with answer key"
                />
                <button className="builder-secondary-button" type="button" onClick={() => examPackageInputRef.current?.click()}>
                  Import exam package
                </button>
                <button className="builder-secondary-button" type="button" onClick={downloadExamPackage} disabled={!formStarted}>
                  Export one-file package
                </button>
              </div>
            </div>
            {documentImportMessage && <p className="builder-message success-message" role="status">{documentImportMessage}</p>}
            {examPackageMessage && <p className={`builder-message${examPackageMessage.startsWith("Imported") ? " success-message" : ""}`} role="status">{examPackageMessage}</p>}

            <div className="builder-steps" aria-label="Exam setup steps">
              {["Details", "Exam type", "Questions"].map((label, index) => {
                const activeStep = formStarted ? 3 : setupStep;
                const step = index + 1;
                return (
                  <div className={`builder-step${activeStep === step ? " active" : ""}${activeStep > step ? " complete" : ""}`} key={label}>
                    <span>{step}</span>{label}
                  </div>
                );
              })}
            </div>

            {!formStarted && setupStep === 1 && (
              <div className="builder-setup-grid builder-setup-grid-details">
                <label className="builder-field builder-title-field" htmlFor="exam-title">
                  <span>EXAM TITLE</span>
                  <input
                    id="exam-title"
                    className="builder-input"
                    value={title}
                    maxLength={120}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="e.g. Biology unit review"
                  />
                  {issues.filter((issue) => issue.field === "title").map((issue) => <small className="field-error" key={issue.message}>{issue.message}</small>)}
                </label>
                <label className="builder-field" htmlFor="item-count">
                  <span>NUMBER OF ITEMS</span>
                  <input
                    id="item-count"
                    className="builder-input"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={itemCount}
                    onChange={(event) => setItemCount(event.target.value)}
                  />
                  {issues.filter((issue) => issue.field === "itemCount").map((issue) => <small className="field-error" key={issue.message}>{issue.message}</small>)}
                </label>
              </div>
            )}

            {!formStarted && setupStep === 2 && (
              <div className="builder-type-step">
                <div className="builder-setup-summary">
                  <div><span>EXAM TITLE</span><strong>{title}</strong></div>
                  <div><span>REQUIRED ITEMS</span><strong>{preparedCount}</strong></div>
                  <div><span>ASSIGNED ITEMS</span><strong>{sumTypeCounts(typeCounts)} / {preparedCount}</strong></div>
                </div>
                <div className="type-count-grid">
                  {examTypes.map((type) => (
                    <label className="builder-field type-count-field" htmlFor={`count-${type}`} key={type}>
                      <span>{getExamTypeLabel(type).toUpperCase()} ITEMS</span>
                      <input
                        id={`count-${type}`}
                        className="builder-input"
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={typeCounts[type]}
                        onChange={(event) => {
                          const nextValue = event.target.value === "" ? 0 : Number(event.target.value);
                          setTypeCounts((current) => ({
                            ...current,
                            [type]: Number.isInteger(nextValue) ? Math.min(Math.max(nextValue, 0), 100) : current[type],
                          }));
                          setIssues((current) => current.filter((issue) => issue.field !== "typeCounts"));
                        }}
                      />
                    </label>
                  ))}
                </div>
                {issues.filter((issue) => issue.field === "typeCounts").map((issue) => <p className="field-error" key={issue.message}>{issue.message}</p>)}
                <p className="type-count-summary">Total assigned: <strong>{sumTypeCounts(typeCounts)}</strong> of {preparedCount} required items.</p>
              </div>
            )}

            {formStarted && (
              <div className="builder-setup-grid">
                <label className="builder-field builder-title-field" htmlFor="exam-title">
                  <span>EXAM TITLE</span>
                  <input id="exam-title" className="builder-input" value={title} disabled />
                </label>
                <label className="builder-field" htmlFor="item-count">
                  <span>NUMBER OF ITEMS</span>
                  <input id="item-count" className="builder-input" type="number" value={preparedCount} disabled />
                </label>
                <label className="builder-field" htmlFor="item-breakdown">
                  <span>ITEMS BY TYPE</span>
                  <input id="item-breakdown" className="builder-input" value={describeTypeCounts(preparedTypeCounts)} disabled />
                </label>
              </div>
            )}

            <div className="builder-setup-actions">
              {!formStarted && setupStep === 1 && (
                <button className="builder-primary-button" type="button" onClick={beginQuestionSetup}>
                  Continue to exam type <span aria-hidden="true">↗</span>
                </button>
              )}
              {!formStarted && setupStep === 2 && (
                <>
                  <button className="builder-secondary-button" type="button" onClick={() => {
                    setSetupStep(1);
                    setIssues([]);
                  }}>Back</button>
                  <button className="builder-primary-button" type="button" onClick={createQuestionSlots}>
                    Create {sumTypeCounts(typeCounts)} question slots <span aria-hidden="true">↗</span>
                  </button>
                </>
              )}
              {formStarted && (
                <button className="builder-secondary-button" type="button" onClick={editSetup}>Change setup</button>
              )}
            </div>

            {formStarted && (
              <>
                <div className="builder-section-rule" />
                <div className="builder-panel-heading question-list-heading">
                  <div>
                    <h2>Questions</h2>
                    <p>{questions.length} of {preparedCount} items · {describeTypeCounts(preparedTypeCounts)}</p>
                  </div>
                </div>

                {preparedTypeCounts.matching > 0 && (
                  <section className="matching-config" aria-label="Matching type setup">
                    <label className="builder-field" htmlFor="matching-instructions">
                      <span>INSTRUCTIONS</span>
                      <textarea
                        id="matching-instructions"
                        className="builder-textarea short-textarea"
                        value={instructions}
                        maxLength={500}
                        onChange={(event) => setInstructions(event.target.value)}
                        placeholder="Match each item in Column A with the correct choice in Column B."
                      />
                    </label>
                    {issues.filter((issue) => issue.field === "instructions").map((issue) => <p className="field-error" key={issue.message}>{issue.message}</p>)}
                    <div className="matching-choice-heading">
                      <h3>Matching choices</h3>
                      <button className="text-action" type="button" onClick={addMatchingChoice}>Add choice</button>
                    </div>
                    <div className="matching-choice-list">
                      {matchingChoices.map((choice, index) => (
                        <div className="matching-choice-row" key={`matching-choice-${index}`}>
                          <span>{String.fromCharCode(65 + index)}</span>
                          <input
                            className="builder-input"
                            value={choice}
                            maxLength={300}
                            onChange={(event) => updateMatchingChoice(index, event.target.value)}
                            aria-label={`Matching choice ${index + 1}`}
                            placeholder={`Choice ${String.fromCharCode(65 + index)}`}
                          />
                          {matchingChoices.length > 2 && <button className="icon-delete" type="button" onClick={() => deleteMatchingChoice(index)} aria-label={`Delete matching choice ${index + 1}`}>×</button>}
                        </div>
                      ))}
                    </div>
                    {issues.filter((issue) => issue.field === "matchingChoices").map((issue) => <p className="field-error" key={issue.message}>{issue.message}</p>)}
                  </section>
                )}

                <div className="builder-question-list">
                  {examTypes.filter((type) => preparedTypeCounts[type] > 0).map((type) => {
                    const typedQuestions = questions.filter((question) => question.type === type);
                    return (
                      <section className="builder-question-group" key={type}>
                        <header className="builder-question-group-heading">
                          <div>
                            <h3>{getExamTypeLabel(type)}</h3>
                            <p>{typedQuestions.length} of {preparedTypeCounts[type]} questions</p>
                          </div>
                          <button
                            className="builder-secondary-button"
                            type="button"
                            onClick={() => addQuestion(type)}
                            disabled={typedQuestions.length >= preparedTypeCounts[type]}
                          >Add question</button>
                        </header>
                        {typedQuestions.map((question) => renderQuestionEditor(question, questions.indexOf(question)))}
                      </section>
                    );
                  })}
                </div>

                {issues.filter((issue) => issue.field === "questions").map((issue) => <p className="field-error count-error" key={issue.message}>{issue.message}</p>)}
                <div className="builder-bottom-actions">
                  <button className="builder-secondary-button" type="button" onClick={handlePreview}>Preview exam</button>
                  <button className="builder-primary-button" type="button" onClick={saveExam} disabled={isSaving}>
                    {isSaving ? "Saving..." : editingExamId ? "Save changes" : "Save exam"}
                    {!isSaving && <span aria-hidden="true">↗</span>}
                  </button>
                </div>
                {formMessage && <p className={`builder-message${formMessage.startsWith("Exam saved") ? " success-message" : ""}`} role="status">{formMessage}</p>}
              </>
            )}
          </section>

          <aside className="saved-exams-panel" aria-label="Saved exams">
            <div className="saved-panel-heading">
              <div>
                <h2>Saved exams</h2>
                <p>{savedExams.length} saved</p>
              </div>
              <button className="icon-add" type="button" onClick={startNewExam} aria-label="Create a new exam" title="Create a new exam">+</button>
            </div>
            {savedListError && <p className="field-error" role="alert">{savedListError}</p>}
            {isLoadingExams ? (
              <p className="saved-empty">Loading saved exams...</p>
            ) : savedExams.length === 0 ? (
              <p className="saved-empty">Saved exams will appear here.</p>
            ) : (
              <ul className="saved-exam-list">
                {savedExams.map((exam) => (
                  <li className="saved-exam-item" key={exam.id}>
                    <button className="saved-exam-open" type="button" onClick={() => viewSavedExam(exam)}>
                      <strong>{exam.title}</strong>
                      <span>{exam.itemCount} items · {describeTypeCounts(exam.typeCounts)}</span>
                      <small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(exam.updatedAt))}</small>
                    </button>
                    <button className="saved-exam-edit" type="button" onClick={() => loadExam(exam.id)} aria-label={`Edit ${exam.title}`} title="Edit exam">Edit</button>
                    <button className="saved-exam-check" type="button" onClick={() => setCheckingExam(exam)} aria-label={`Check answers for ${exam.title}`} title="Check student answers">Check</button>
                    <button className="saved-exam-delete" type="button" onClick={() => removeExam(exam.id, exam.title)} aria-label={`Delete ${exam.title}`} title="Delete exam">×</button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      </div>

      {previewDraft && (
        <div className="preview-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPreviewDraft(null);
        }}>
          <section className="exam-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <header className="preview-dialog-header">
              <div>
                <p className="eyebrow">{previewSavedExamId ? "SAVED EXAM" : "EXAM PREVIEW"}</p>
                <h2 id="preview-title">{previewDraft.title}</h2>
                <p>{previewDraft.itemCount} items · {describeTypeCounts(previewDraft.typeCounts)}</p>
              </div>
              <button className="icon-delete" type="button" onClick={() => setPreviewDraft(null)} aria-label="Close preview">×</button>
            </header>
            <div className="preview-dialog-content">
              {previewDraft.typeCounts.matching > 0 && (
                <div className="preview-matching-info">
                  <p><strong>Instructions:</strong> {previewDraft.instructions}</p>
                  <ol type="A">{previewDraft.matchingChoices.filter((choice) => choice.trim()).map((choice, index) => <li key={`${choice}-${index}`}>{choice}</li>)}</ol>
                </div>
              )}
              {previewDraft.questions.map((question, index) => (
                <article className="preview-question" key={question.id}>
                  <h3><span>{index + 1}.</span> {question.prompt}</h3>
                  {question.type === "multiple-choice" && (
                    <ul>{question.choices.map((choice, choiceIndex) => <li key={`${question.id}-${choiceIndex}`}>{choiceLetters[choiceIndex]}. {choice}</li>)}</ul>
                  )}
                  {question.type === "true-false" && <p className="preview-answer">Correct answer: {question.correctAnswer}</p>}
                  {question.type === "identification" && <p className="preview-answer">Correct answer: {question.correctAnswer}</p>}
                  {question.type === "matching" && <p className="preview-answer">Correct match: {answerLabel(question, previewDraft.matchingChoices)}</p>}
                  {question.type === "multiple-choice" && <p className="preview-answer">Correct answer: {answerLabel(question, previewDraft.matchingChoices)}</p>}
                </article>
              ))}
            </div>
            <footer className="preview-dialog-actions">
              <button className="builder-secondary-button" type="button" onClick={() => setPreviewDraft(null)}>Close preview</button>
              <button className="builder-secondary-button" type="button" onClick={() => void downloadAnswerSheetPdf(previewDraft)}>Answer sheet PDF</button>
              <button className="builder-secondary-button" type="button" onClick={() => void downloadAnswerKeyPdf(previewDraft)}>Answer key PDF</button>
              {previewSavedExamId ? (
                <button className="builder-primary-button" type="button" onClick={() => {
                  const examId = previewSavedExamId;
                  setPreviewDraft(null);
                  setPreviewSavedExamId(null);
                  void loadExam(examId);
                }}>Edit exam</button>
              ) : (
                <button className="builder-primary-button" type="button" onClick={() => {
                  setPreviewDraft(null);
                  void saveExam();
                }} disabled={isSaving}>{isSaving ? "Saving..." : editingExamId ? "Save changes" : "Save exam"}</button>
              )}
            </footer>
          </section>
        </div>
      )}

      {checkingExam && <AnswerChecker exam={checkingExam} onClose={() => setCheckingExam(null)} />}
    </main>
  );
}

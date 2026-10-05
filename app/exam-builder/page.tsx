'use client';

import Link from "next/link";
import { useEffect, useState } from "react";
import type { jsPDF as JsPDFDocument } from "jspdf";
import AnswerChecker from "./answer-checker";
import { validateExamDraft } from "@/app/lib/exam-validation";
import { examTypes, normalizeExamDraft, type ExamDraft, type ExamQuestion, type ExamType, type ExamTypeCounts, type SavedExam, type ValidationIssue } from "@/app/lib/exam-types";

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
    const pdf = new jsPDF({ unit: "mm", format: [215.9, 330.2] });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 16;
    const contentWidth = pageWidth - margin * 2;
    const bottom = pageHeight - 17;
    let y = 62;

    function startPage() {
      drawLongPaperHeader(pdf, exam.title, "Answer Sheet", `${exam.itemCount} items`);
      y = 62;
    }

    function ensureRoom(height: number) {
      if (y + height > bottom) {
        pdf.addPage();
        startPage();
      }
    }

    startPage();
    pdf.setTextColor(23, 44, 37);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.text("Student name:", margin, y);
    pdf.line(margin + 24, y + 1, 126, y + 1);
    pdf.text("Date:", 143, y);
    pdf.line(155, y + 1, pageWidth - margin, y + 1);
    y += 14;

    if (exam.typeCounts.matching > 0) {
      ensureRoom(23);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.text("MATCHING CHOICES", margin, y);
      y += 7;
      const matchingChoiceText = exam.matchingChoices
        .filter((choice) => choice.trim())
        .map((choice, index) => `${String.fromCharCode(65 + index)}. ${choice}`)
        .join("     ");
      const choiceLines = pdf.splitTextToSize(matchingChoiceText, contentWidth) as string[];
      ensureRoom(choiceLines.length * 5 + 7);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.text(choiceLines, margin, y);
      y += choiceLines.length * 5 + 5;
    }

    let previousType: ExamType | null = null;
    exam.questions.forEach((question, index) => {
      if (question.type !== previousType) {
        ensureRoom(15);
        pdf.setFillColor(241, 246, 241);
        pdf.rect(margin, y, contentWidth, 8, "F");
        pdf.setTextColor(39, 85, 66);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.text(getExamTypeLabel(question.type).toUpperCase(), margin + 3, y + 5.5);
        y += 12;
        previousType = question.type;
      }

      ensureRoom(11);
      pdf.setTextColor(23, 44, 37);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.text(String(index + 1).padStart(2, "0"), margin + 1, y + 2.5);

      if (question.type === "multiple-choice") {
        choiceLetters.forEach((letter, choiceIndex) => {
          const centerX = margin + 37 + choiceIndex * 31;
          pdf.setDrawColor(95, 119, 104);
          pdf.circle(centerX, y, 3.4, "S");
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(7);
          pdf.text(letter, centerX, y + 1, { align: "center" });
        });
      } else if (question.type === "true-false") {
        ["T", "F"].forEach((letter, optionIndex) => {
          const centerX = margin + 38 + optionIndex * 31;
          pdf.setDrawColor(95, 119, 104);
          pdf.circle(centerX, y, 3.4, "S");
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(7);
          pdf.text(letter, centerX, y + 1, { align: "center" });
        });
      } else {
        pdf.setDrawColor(151, 166, 154);
        pdf.line(margin + 27, y + 4, pageWidth - margin, y + 4);
      }
      y += 11;
    });

    const pageCount = pdf.getNumberOfPages();
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

    function writeAnswer(text: string) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      const lines = pdf.splitTextToSize(text, pageWidth - margin * 2 - 8) as string[];
      const height = Math.max(lines.length, 1) * 5;
      if (y + height > bottom) {
        pdf.addPage();
        startPage();
      }
      pdf.setTextColor(23, 44, 37);
      pdf.text(lines, margin + 3, y);
      y += height + 3;
    }

    startPage();
    let previousType: ExamType | null = null;
    exam.questions.forEach((question, index) => {
      if (question.type !== previousType) {
        if (y + 12 > bottom) {
          pdf.addPage();
          startPage();
        }
        pdf.setTextColor(39, 85, 66);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        pdf.text(getExamTypeLabel(question.type).toUpperCase(), margin, y);
        y += 7;
        previousType = question.type;
      }
      writeAnswer(`${String(index + 1).padStart(2, "0")}. ${answerLabel(question, exam.matchingChoices)}`);
    });

    const pageCount = pdf.getNumberOfPages();
    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
      pdf.setPage(pageIndex);
      pdf.setTextColor(102, 118, 110);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.text(`Page ${pageIndex} of ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
    }

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
              {editingExamId && <span className="editing-indicator">EDITING SAVED EXAM</span>}
            </div>

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

'use client';

import Image from "next/image";
import { zipSync } from "fflate";
import { createWorker } from "tesseract.js";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

type CheckState = "idle" | "reading" | "checked" | "error";

const ignoredWords = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been",
  "before", "being", "between", "both", "but", "can", "could", "does",
  "each", "for", "from", "have", "into", "its", "more", "most", "not",
  "only", "other", "over", "same", "some", "such", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those",
  "through", "under", "using", "very", "was", "were", "what", "when",
  "which", "while", "with", "would",
]);

function getKeywords(answer: string) {
  const words = answer.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const keywords = words.filter((word) => word.length > 2 && !ignoredWords.has(word));
  return new Set(keywords.length > 0 ? keywords : words);
}

function getCoverage(reference: string, response: string) {
  const expected = getKeywords(reference);
  const actual = getKeywords(response);
  if (expected.size === 0 || actual.size === 0) return 0;

  let matched = 0;
  expected.forEach((word) => {
    if (actual.has(word)) matched += 1;
  });
  return Math.round((matched / expected.size) * 100);
}

async function recognizeImage(image: File, onProgress: (progress: number) => void) {
  const worker = await createWorker("eng", 1, {
    logger: (message) => {
      if (message.status === "recognizing text") {
        onProgress(Math.round(message.progress * 100));
      }
    },
  });

  try {
    const { data } = await worker.recognize(image);
    return data.text.trim();
  } finally {
    await worker.terminate();
  }
}

function CameraIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M4 7.5h3l1.4-2h7.2l1.4 2h3v11H4v-11Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export default function Home() {
  const [referenceAnswer, setReferenceAnswer] = useState("");
  const [studentAnswer, setStudentAnswer] = useState("");
  const [multipleChoiceCount, setMultipleChoiceCount] = useState("20");
  const [multipleChoiceStudents, setMultipleChoiceStudents] = useState("1");
  const [isBuildingSheets, setIsBuildingSheets] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraExpanded, setCameraExpanded] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [keySheetName, setKeySheetName] = useState("");
  const [isReadingKey, setIsReadingKey] = useState(false);
  const [keySheetError, setKeySheetError] = useState("");
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const keySheetInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const score = getCoverage(referenceAnswer, studentAnswer);
  const canCheck = referenceAnswer.trim().length > 0 &&
    (photo !== null || studentAnswer.trim().length > 0) &&
    checkState !== "reading";

  async function startCamera() {
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Live camera needs a secure HTTPS page and a supported browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      cameraStreamRef.current = stream;
      if (!videoRef.current) throw new Error("The camera preview could not be opened.");
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);
    } catch (error) {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraError(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Camera permission was blocked. Allow camera access in your browser settings, then try again."
          : error instanceof Error
            ? error.message
            : "The camera could not be started.",
      );
    }
  }

  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setCameraExpanded(false);
  }

  async function capturePhoto() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError("Wait for the camera preview, then capture the page.");
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
    const image = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.92);
    });
    if (!image) {
      setCameraError("The camera image could not be captured. Please try again.");
      return;
    }

    const capturedPhoto = new File([image], "student-response.jpg", { type: "image/jpeg" });
    stopCamera();
    setPhoto(capturedPhoto);
    setPreviewUrl(URL.createObjectURL(capturedPhoto));
    setStudentAnswer("");
    setCheckState("idle");
    setErrorMessage("");
    setProgress(0);
  }

  async function handleKeySheetUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const uploadedSheet = input.files?.[0];
    if (!uploadedSheet) return;

    setKeySheetName(uploadedSheet.name);
    setKeySheetError("");
    setIsReadingKey(true);
    try {
      if (!uploadedSheet.type.startsWith("image/")) {
        throw new Error("Choose an image of the completed key sheet.");
      }
      const text = await recognizeImage(uploadedSheet, () => {});
      if (!text) throw new Error("No text was found. Try a clearer image of the key sheet.");
      setReferenceAnswer(text);
    } catch (error) {
      setKeySheetError(error instanceof Error ? error.message : "The answer sheet could not be read.");
    } finally {
      setIsReadingKey(false);
      input.value = "";
    }
  }

  async function downloadAnswerSheet() {
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ format: "a4", unit: "mm" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const margin = 17;

    pdf.setFillColor(23, 98, 77);
    pdf.rect(0, 0, pageWidth, 35, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(9);
    pdf.text("MARKWISE  /  EXAM CHECKER", margin, 12);
    pdf.setFont("times", "bold");
    pdf.setFontSize(23);
    pdf.text("Answer key sheet", margin, 25);

    pdf.setTextColor(23, 44, 37);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text("Subject:", margin, 46);
    pdf.line(margin + 18, 47, 94, 47);
    pdf.text("Teacher:", 105, 46);
    pdf.line(123, 47, pageWidth - margin, 47);
    pdf.setFontSize(8);
    pdf.setTextColor(102, 118, 110);
    pdf.text("Write the expected answer or essential key ideas for each question.", margin, 57);

    for (let index = 0; index < 10; index += 1) {
      const top = 65 + index * 22;
      pdf.setDrawColor(216, 224, 217);
      pdf.setFillColor(248, 250, 247);
      pdf.roundedRect(margin, top, pageWidth - margin * 2, 19, 1.5, 1.5, "FD");
      pdf.setTextColor(23, 98, 77);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.text(`Q${index + 1}`, margin + 4, top + 7);
      pdf.setDrawColor(225, 231, 225);
      pdf.line(margin + 17, top + 10, pageWidth - margin - 4, top + 10);
      pdf.line(margin + 17, top + 15, pageWidth - margin - 4, top + 15);
    }

    pdf.setTextColor(102, 118, 110);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.text("Markwise  /  Check recognized text before grading", margin, 286);
    pdf.save("markwise-answer-key-sheet.pdf");
  }

  async function downloadMultipleChoiceSheet() {
    const itemCount = Number(multipleChoiceCount);
    const studentCount = Number(multipleChoiceStudents);
    if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > 200) return;
    if (!Number.isInteger(studentCount) || studentCount < 1 || studentCount > 100) return;

    setIsBuildingSheets(true);
    try {
      const { jsPDF } = await import("jspdf");
      const pdfFiles: Record<string, Uint8Array> = {};
      const margin = 15;
      const columnGap = 12;
      const rowsPerColumn = 25;
      const itemsPerPage = rowsPerColumn * 2;
      const options = ["A", "B", "C", "D"];
      const pagesPerStudent = Math.ceil(itemCount / itemsPerPage);

      for (let studentIndex = 0; studentIndex < studentCount; studentIndex += 1) {
        const pdf = new jsPDF({ format: "a4", unit: "mm" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const columnWidth = (pageWidth - margin * 2 - columnGap) / 2;

        for (let pageIndex = 0; pageIndex < pagesPerStudent; pageIndex += 1) {
          if (pageIndex > 0) pdf.addPage();

          pdf.setFillColor(23, 98, 77);
          pdf.rect(0, 0, pageWidth, 32, "F");
          pdf.setTextColor(255, 255, 255);
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(8);
          pdf.text("MARKWISE  /  PRINTABLE EXAM SHEET", margin, 11);
          pdf.text(`STUDENT COPY ${studentIndex + 1}`, pageWidth - margin, 11, { align: "right" });
          pdf.setFont("times", "bold");
          pdf.setFontSize(21);
          pdf.text("Multiple choice", margin, 24);

          pdf.setTextColor(23, 44, 37);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(9);
          pdf.text("Student name:", margin, 43);
          pdf.line(margin + 24, 44, 104, 44);
          pdf.text("Date:", 119, 43);
          pdf.line(132, 44, pageWidth - margin, 44);
          pdf.setTextColor(102, 118, 110);
          pdf.setFontSize(8);
          pdf.text("Fill one circle for each question. Options: A, B, C, or D.", margin, 54);

          const firstItem = pageIndex * itemsPerPage;
          const finalItem = Math.min(firstItem + itemsPerPage, itemCount);
          for (let itemIndex = firstItem; itemIndex < finalItem; itemIndex += 1) {
            const localIndex = itemIndex - firstItem;
            const columnIndex = Math.floor(localIndex / rowsPerColumn);
            const rowIndex = localIndex % rowsPerColumn;
            const x = margin + columnIndex * (columnWidth + columnGap);
            const y = 63 + rowIndex * 8.3;

            pdf.setTextColor(23, 44, 37);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(8);
            pdf.text(String(itemIndex + 1).padStart(2, "0"), x, y + 2.7);
            pdf.setDrawColor(198, 210, 200);
            pdf.setLineWidth(0.25);
            pdf.line(x, y + 5, x + columnWidth, y + 5);

            options.forEach((option, optionIndex) => {
              const centerX = x + 24 + optionIndex * 13.5;
              const centerY = y + 2.2;
              pdf.setDrawColor(95, 119, 104);
              pdf.circle(centerX, centerY, 2.5, "S");
              pdf.setFont("helvetica", "normal");
              pdf.setFontSize(6);
              pdf.setTextColor(67, 84, 73);
              pdf.text(option, centerX, centerY + 0.75, { align: "center" });
            });
          }

          pdf.setDrawColor(216, 224, 217);
          pdf.line(margin, 283, pageWidth - margin, 283);
          pdf.setTextColor(102, 118, 110);
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(8);
          pdf.text(`Student ${studentIndex + 1} of ${studentCount} · Items ${firstItem + 1}-${finalItem}`, margin, 289);
          pdf.text(`Page ${pageIndex + 1} of ${pagesPerStudent}`, pageWidth - margin, 289, { align: "right" });
        }

        const studentFileName = `student-${String(studentIndex + 1).padStart(3, "0")}.pdf`;
        pdfFiles[studentFileName] = new Uint8Array(pdf.output("arraybuffer"));
      }

      const archive = zipSync(pdfFiles, { level: 6 });
      const downloadUrl = URL.createObjectURL(new Blob([archive], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `markwise-${studentCount}-student-sheets-${itemCount}-items.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } finally {
      setIsBuildingSheets(false);
    }
  }

  async function handleCheck() {
    if (!referenceAnswer.trim()) {
      setErrorMessage("Add the answer key before checking a response.");
      setCheckState("error");
      return;
    }

    if (photo) {
      setCheckState("reading");
      setProgress(0);
      setErrorMessage("");

      try {
        const text = await recognizeImage(photo, setProgress);
        if (!text) {
          throw new Error("No text was found. Try a brighter, closer photo.");
        }
        setStudentAnswer(text);
        setCheckState("checked");
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "The photo could not be read.",
        );
        setCheckState("error");
      }
      return;
    }

    if (!studentAnswer.trim()) {
      setErrorMessage("Add a student response or take a photo of the exam.");
      setCheckState("error");
      return;
    }

    setErrorMessage("");
    setCheckState("checked");
  }

  function handleRemovePhoto() {
    setPhoto(null);
    setPreviewUrl(null);
    setCheckState("idle");
    setProgress(0);
  }

  return (
    <main className="exam-app">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Markwise home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>markwise</span>
        </a>
        <div className="topbar-actions">
          <a className="topbar-builder-link" href="/exam-builder">Exam builder</a>
          <div className="topbar-note"><span className="status-dot" /> created by Hydra</div>
        </div>
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <p className="eyebrow">EXAM CHECKER <span> / </span> 01</p>
          <h1>Good answers<br /><em>deserve credit.</em></h1>
          <p className="intro-text">Set your answer key, scan a student response, and get a quick first-pass check.</p>
        </div>
        <div className="workflow" aria-label="Checking workflow">
          <div className="workflow-step active"><span>1</span><span>Answer key</span></div>
          <span className="workflow-line" />
          <div className="workflow-step"><span>2</span><span>Student paper</span></div>
          <span className="workflow-line" />
          <div className="workflow-step"><span>3</span><span>Review</span></div>
        </div>
      </section>

      <section className="checker" aria-label="Exam answer checker">
        <div className="checker-column key-column">
          <div className="section-heading">
            <span className="step-index">01</span>
            <div>
              <h2>Answer key</h2>
              <p>The expected answer to compare against</p>
            </div>
          </div>
          <label className="field-label" htmlFor="reference-answer">REFERENCE ANSWER</label>
          <div className="key-sheet-tools">
            <input
              ref={keySheetInputRef}
              className="file-input"
              type="file"
              accept="image/*"
              onChange={handleKeySheetUpload}
              aria-label="Upload a completed answer-key sheet"
            />
            <button className="sheet-button" type="button" onClick={() => keySheetInputRef.current?.click()} disabled={isReadingKey}>
              {isReadingKey ? "Reading sheet..." : "Upload completed key sheet"}
            </button>
            <button className="sheet-button sheet-download" type="button" onClick={downloadAnswerSheet}>
              Download blank PDF
            </button>
          </div>
          {keySheetName && <p className="sheet-filename">Last sheet: {keySheetName}</p>}
          {keySheetError && <p className="error-message" role="alert">{keySheetError}</p>}
          <textarea
            id="reference-answer"
            className="answer-input reference-input"
            value={referenceAnswer}
            onChange={(event) => setReferenceAnswer(event.target.value)}
            placeholder="Type or paste the correct answer here..."
            maxLength={4000}
          />
          <div className="field-meta"><span>Keep it focused on the key ideas</span><span>{referenceAnswer.length} / 4000</span></div>

          <div className="scoring-note">
            <span className="note-symbol" aria-hidden="true">i</span>
            <p>Scores show how many key terms appear in the response. Review the work yourself for meaning and partial credit.</p>
          </div>
        </div>

        <div className="checker-divider" aria-hidden="true" />

        <div className="checker-column response-column">
          <div className="section-heading">
            <span className="step-index step-index-coral">02</span>
            <div>
              <h2>Student response</h2>
              <p>Take a photo or enter the answer below</p>
            </div>
          </div>

          <div className={`photo-well${previewUrl ? " has-photo" : ""}${cameraActive ? " camera-live" : ""}${cameraExpanded ? " camera-expanded" : ""}`}>
            <video ref={videoRef} className={`camera-feed${cameraActive ? " active" : ""}`} autoPlay muted playsInline aria-label="Live camera preview" />
            {previewUrl ? (
              <>
                <Image className="photo-preview" src={previewUrl} alt="Preview of the exam response" width={1200} height={800} unoptimized />
                <button className="remove-photo" type="button" onClick={handleRemovePhoto} aria-label="Remove photo" title="Remove photo">×</button>
                <div className="photo-caption"><span className="status-dot" /> Photo ready to scan</div>
              </>
            ) : cameraActive ? (
              <div className="camera-controls">
                <button className="camera-button" type="button" onClick={capturePhoto}><CameraIcon /> Capture page</button>
                <button className="camera-expand-button" type="button" onClick={() => setCameraExpanded((expanded) => !expanded)} aria-pressed={cameraExpanded}>
                  {cameraExpanded ? "Collapse" : "Expand"}
                </button>
                <button className="camera-cancel" type="button" onClick={stopCamera}>Cancel</button>
              </div>
            ) : (
              <div className="upload-label">
                <span className="camera-icon"><CameraIcon /></span>
                <span className="upload-title">Open live camera</span>
                <span className="upload-hint">Point your phone at the student&apos;s answer</span>
                <button className="camera-button" type="button" onClick={startCamera}><CameraIcon /> Start camera</button>
              </div>
            )}
          </div>
          <p className="privacy-note">Live preview stays on this device. Clear image files work best.</p>
          {cameraError && <p className="error-message" role="alert">{cameraError}</p>}

          <label className="field-label response-label" htmlFor="student-answer">RECOGNIZED / TYPED ANSWER</label>
          <textarea
            id="student-answer"
            className="answer-input student-input"
            value={studentAnswer}
            onChange={(event) => {
              setStudentAnswer(event.target.value);
              if (checkState !== "reading") setCheckState("idle");
            }}
            placeholder="After scanning, the recognized text appears here. You can edit it before checking."
            maxLength={4000}
          />
          <div className="field-meta"><span>Handwriting recognition may need a quick edit</span><span>{studentAnswer.length} / 4000</span></div>

          {checkState === "reading" && (
            <div className="progress-wrap" role="status" aria-live="polite">
              <div className="progress-copy"><span>Reading your photo</span><span>{progress}%</span></div>
              <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            </div>
          )}

          {checkState === "error" && <p className="error-message" role="alert">{errorMessage}</p>}

          <button className="check-button" type="button" onClick={handleCheck} disabled={!canCheck}>
            {checkState === "reading" ? "Reading response..." : photo ? "Read photo & check" : "Check response"}
            {checkState !== "reading" && <span aria-hidden="true">↗</span>}
          </button>
        </div>
      </section>

      <section className="mcq-maker" aria-labelledby="mcq-title">
        <div className="mcq-copy">
          <p className="eyebrow">PRINTABLE SHEET <span> / </span> MULTIPLE CHOICE</p>
          <h2 id="mcq-title">Build an answer sheet</h2>
          <p>Choose how many questions to include. Each question has A–D bubbles.</p>
        </div>
        <div className="mcq-actions">
          <div className="mcq-controls">
            <div className="mcq-count-fields">
              <label className="mcq-field" htmlFor="mcq-count">
                <span>NUMBER OF ITEMS</span>
                <input
                  id="mcq-count"
                  className="mcq-count"
                  type="number"
                  min={1}
                  max={200}
                  step={1}
                  value={multipleChoiceCount}
                  onChange={(event) => setMultipleChoiceCount(event.target.value)}
                />
              </label>
              <label className="mcq-field" htmlFor="mcq-students">
                <span>NUMBER OF STUDENTS</span>
                <input
                  id="mcq-students"
                  className="mcq-count"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={multipleChoiceStudents}
                  onChange={(event) => setMultipleChoiceStudents(event.target.value)}
                />
              </label>
            </div>
            <button
              className="mcq-download"
              type="button"
              onClick={downloadMultipleChoiceSheet}
              disabled={
                isBuildingSheets ||
                !Number.isInteger(Number(multipleChoiceCount)) || Number(multipleChoiceCount) < 1 || Number(multipleChoiceCount) > 200 ||
                !Number.isInteger(Number(multipleChoiceStudents)) || Number(multipleChoiceStudents) < 1 || Number(multipleChoiceStudents) > 100
              }
            >
              {isBuildingSheets ? "Creating PDFs..." : `Generate ${multipleChoiceStudents || 0} PDFs`} <span aria-hidden="true">↗</span>
            </button>
          </div>
          <p className="mcq-limit">One individual PDF per student, downloaded together as a ZIP</p>
        </div>
      </section>

      {checkState === "checked" && (
        <section className="result" aria-live="polite">
          <div className="result-score">
            <span className="result-label">KEYWORD COVERAGE</span>
            <strong>{score}<small>%</small></strong>
          </div>
          <div className="result-copy">
            <h2>{score >= 80 ? "Strong match" : score >= 50 ? "Some key ideas found" : "Review this response"}</h2>
            <p>{score}% of the answer key&apos;s key terms appear in the student response. Check the wording and meaning before assigning a grade.</p>
          </div>
          <button className="reset-button" type="button" onClick={() => {
            setStudentAnswer("");
            setPhoto(null);
            setPreviewUrl(null);
            setCheckState("idle");
            setProgress(0);
          }}>Check another <span aria-hidden="true">↗</span></button>
        </section>
      )}

      <footer className="page-footer">
        <span>MARKWISE <span className="footer-separator">/</span> EXAM CHECKER</span>
        <span>First-pass feedback, always reviewed by a person.</span>
      </footer>
    </main>
  );
}

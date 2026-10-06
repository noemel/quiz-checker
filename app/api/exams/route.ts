import { insertExam, listExams } from "@/app/lib/exam-database";
import type { ExamDraft } from "@/app/lib/exam-types";
import { validateExamDraft } from "@/app/lib/exam-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ exams: await listExams() });
  } catch (error) {
    console.error("Failed to list saved exams:", error);
    return Response.json({ error: "Saved exams could not be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const issues = validateExamDraft(body);
  if (issues.length > 0) {
    return Response.json({ error: "Exam validation failed.", issues }, { status: 400 });
  }

  try {
    const exam = await insertExam(body as ExamDraft);
    return Response.json({ exam }, { status: 201 });
  } catch {
    return Response.json({ error: "Exam could not be saved." }, { status: 500 });
  }
}
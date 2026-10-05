import { deleteExam, getExam, updateExam } from "@/app/lib/exam-database";
import type { ExamDraft } from "@/app/lib/exam-types";
import { validateExamDraft } from "@/app/lib/exam-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const exam = await getExam(id);
    return exam
      ? Response.json({ exam })
      : Response.json({ error: "Exam not found." }, { status: 404 });
  } catch {
    return Response.json({ error: "Exam could not be loaded." }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
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
    const exam = await updateExam(id, body as ExamDraft);
    return exam
      ? Response.json({ exam })
      : Response.json({ error: "Exam not found." }, { status: 404 });
  } catch {
    return Response.json({ error: "Exam could not be updated." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    return (await deleteExam(id))
      ? new Response(null, { status: 204 })
      : Response.json({ error: "Exam not found." }, { status: 404 });
  } catch {
    return Response.json({ error: "Exam could not be deleted." }, { status: 500 });
  }
}
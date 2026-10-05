import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Exam Builder | Markwise",
  description: "Create, preview, save, and print custom exams with answer keys.",
};

export default function ExamBuilderLayout({ children }: { children: ReactNode }) {
  return children;
}

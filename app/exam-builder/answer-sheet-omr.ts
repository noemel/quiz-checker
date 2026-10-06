import type { ExamType } from "@/app/lib/exam-types";

export const answerSheetPageWidth = 215.9;
export const answerSheetPageHeight = 330.2;
export const answerSheetStartY = 80;
export const answerSheetBottomY = 302;
export const answerSheetMarkers = [
  { x: 9, y: 56 },
  { x: 206.9, y: 56 },
  { x: 206.9, y: 316 },
  { x: 9, y: 316 },
] as const;

export interface AnswerBubble {
  label: string;
  x: number;
  y: number;
}

export interface AnswerSheetRow {
  questionIndex: number;
  type: ExamType;
  page: number;
  y: number;
  height: number;
  bubbles: AnswerBubble[];
}

export interface AnswerSheetLayout {
  rows: AnswerSheetRow[];
  pageCount: number;
}

export interface MatchingChoiceRow {
  entries: { label: string; lines: string[] }[];
  height: number;
}

function optionLabel(index: number) {
  return String.fromCharCode(65 + index);
}

export function createMatchingChoiceRows(choices: string[]): MatchingChoiceRow[] {
  const entries = choices.map((choice, index) => {
    const lines: string[] = [];
    let line = "";
    choice.trim().split(/\s+/).forEach((word) => {
      let remaining = word;
      while (remaining.length > 44) {
        if (line) lines.push(line);
        line = remaining.slice(0, 44);
        remaining = remaining.slice(44);
      }
      if (!remaining) return;
      if (line && `${line} ${remaining}`.length > 44) {
        lines.push(line);
        line = remaining;
      } else {
        line = line ? `${line} ${remaining}` : remaining;
      }
    });
    if (line) lines.push(line);
    return { label: optionLabel(index), lines: lines.length ? lines : [""] };
  });

  const rows: MatchingChoiceRow[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const pair = entries.slice(index, index + 2);
    rows.push({
      entries: pair,
      height: Math.max(...pair.map((entry) => entry.lines.length)) * 3.5 + 2,
    });
  }
  return rows;
}

export function matchingChoiceBlockHeight(choices: string[]) {
  const rows = createMatchingChoiceRows(choices);
  return rows.length ? 11 + rows.reduce((total, row) => total + row.height, 0) : 0;
}

export function createAnswerSheetLayout(
  questions: { type: ExamType }[],
  matchingChoices: string[],
): AnswerSheetLayout {
  const rows: AnswerSheetRow[] = [];
  let page = 0;
  const hasMatchingQuestions = questions.some((question) => question.type === "matching");
  let y = answerSheetStartY + (hasMatchingQuestions ? matchingChoiceBlockHeight(matchingChoices) : 0);

  questions.forEach((question, questionIndex) => {
    const matchingLines = question.type === "matching"
      ? Math.max(1, Math.ceil(matchingChoices.length / 11))
      : 1;
    const height = Math.max(12, matchingLines * 11);
    if (y + height > answerSheetBottomY) {
      page += 1;
      y = answerSheetStartY;
    }

    let labels: string[] = [];
    if (question.type === "multiple-choice") labels = ["A", "B", "C", "D"];
    if (question.type === "true-false") labels = ["T", "F"];
    if (question.type === "matching") labels = matchingChoices.map((_, index) => optionLabel(index));

    const bubbles = labels.map((label, optionIndex) => {
      const matchingLine = Math.floor(optionIndex / 11);
      const matchingColumn = optionIndex % 11;
      return {
        label,
        x: question.type === "matching" ? 58 + matchingColumn * 12.7 : 61 + optionIndex * 26,
        y: y + 6 + (question.type === "matching" ? matchingLine * 11 : 0),
      };
    });

    rows.push({ questionIndex, type: question.type, page, y, height, bubbles });
    y += height;
  });

  return { rows, pageCount: page + 1 };
}

export function pageIndexFromOcr(text: string, pageCount: number) {
  const match = text.match(/\bpage\s+(\d+)\s+(?:of|\/)\s+\d+\b/i);
  const pageIndex = match ? Number(match[1]) - 1 : -1;
  return pageIndex >= 0 && pageIndex < pageCount ? pageIndex : null;
}

interface Point {
  x: number;
  y: number;
}

interface Component {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

function findRegistrationMarks(image: ImageData) {
  const { width, height, data } = image;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const candidates: Component[] = [];

  for (let seed = 0; seed < width * height; seed += 1) {
    if (visited[seed]) continue;
    const seedOffset = seed * 4;
    const seedGray = (data[seedOffset] * 299 + data[seedOffset + 1] * 587 + data[seedOffset + 2] * 114) / 1000;
    if (seedGray > 105) continue;

    let head = 0;
    let tail = 0;
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    queue[tail++] = seed;
    visited[seed] = 1;

    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);

      const neighbors = [x > 0 ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1, y + 1 < height ? pixel + width : -1];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor]) continue;
        const offset = neighbor * 4;
        const gray = (data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000;
        if (gray > 105) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }

    const componentWidth = right - left + 1;
    const componentHeight = bottom - top + 1;
    const size = Math.max(componentWidth, componentHeight);
    const aspect = componentWidth / componentHeight;
    const density = tail / (componentWidth * componentHeight);
    if (size >= 8 && size <= width * 0.06 && aspect >= 0.78 && aspect <= 1.28 && density >= 0.68) {
      candidates.push({
        x: (left + right) / 2,
        y: (top + bottom) / 2,
        width: componentWidth,
        height: componentHeight,
        area: tail,
      });
    }
  }

  if (candidates.length < 4) return null;
  const topLeft = candidates.reduce((best, point) => point.x + point.y < best.x + best.y ? point : best);
  const topRight = candidates.reduce((best, point) => point.x - point.y > best.x - best.y ? point : best);
  const bottomRight = candidates.reduce((best, point) => point.x + point.y > best.x + best.y ? point : best);
  const bottomLeft = candidates.reduce((best, point) => point.x - point.y < best.x - best.y ? point : best);
  if (new Set([topLeft, topRight, bottomRight, bottomLeft]).size !== 4) return null;
  return [topLeft, topRight, bottomRight, bottomLeft] as const;
}

function solveHomography(source: readonly Point[], target: readonly Point[]) {
  const matrix: number[][] = [];
  source.forEach(({ x, y }, index) => {
    const { x: targetX, y: targetY } = target[index];
    matrix.push([x, y, 1, 0, 0, 0, -targetX * x, -targetX * y, targetX]);
    matrix.push([0, 0, 0, x, y, 1, -targetY * x, -targetY * y, targetY]);
  });

  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    if (Math.abs(divisor) < 1e-10) return null;
    for (let entry = column; entry <= 8; entry += 1) matrix[column][entry] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let entry = column; entry <= 8; entry += 1) {
        matrix[row][entry] -= factor * matrix[column][entry];
      }
    }
  }
  return matrix.map((row) => row[8]);
}

function transformPoint(matrix: number[], point: Point): Point | null {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + 1;
  if (Math.abs(denominator) < 1e-10) return null;
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function averageDisk(image: ImageData, center: Point, radius: number) {
  const left = Math.max(0, Math.floor(center.x - radius));
  const right = Math.min(image.width - 1, Math.ceil(center.x + radius));
  const top = Math.max(0, Math.floor(center.y - radius));
  const bottom = Math.min(image.height - 1, Math.ceil(center.y + radius));
  let total = 0;
  let count = 0;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if ((x - center.x) ** 2 + (y - center.y) ** 2 > radius ** 2) continue;
      const offset = (y * image.width + x) * 4;
      total += (image.data[offset] * 299 + image.data[offset + 1] * 587 + image.data[offset + 2] * 114) / 1000;
      count += 1;
    }
  }
  return count ? total / count : 255;
}

export async function readMarkedAnswers(
  file: File,
  layout: AnswerSheetLayout,
  pageIndex: number,
) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser could not analyze the answer sheet.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const detectedMarks = findRegistrationMarks(image);
  if (!detectedMarks) throw new Error("The answer-sheet alignment marks were not found.");

  const pageMarks = answerSheetMarkers.map(({ x, y }) => ({ x, y }));
  const homography = solveHomography(pageMarks, detectedMarks);
  if (!homography) throw new Error("The answer sheet could not be aligned.");
  const mapPoint = (x: number, y: number) => transformPoint(homography, { x, y });
  const referencePoint = mapPoint(190, 72);
  if (!referencePoint) throw new Error("The answer sheet could not be aligned.");
  const referenceGray = averageDisk(image, referencePoint, 2);
  const answers = new Map<number, string>();

  layout.rows.filter((row) => row.page === pageIndex && row.bubbles.length > 0).forEach((row) => {
    const scores = row.bubbles.map((bubble) => {
      const center = mapPoint(bubble.x, bubble.y);
      const nearby = mapPoint(bubble.x + 1, bubble.y);
      if (!center || !nearby) return { label: bubble.label, marked: false, gray: 255 };
      const radius = Math.max(2, Math.hypot(nearby.x - center.x, nearby.y - center.y) * 1.35);
      const gray = averageDisk(image, center, radius);
      return { label: bubble.label, marked: gray < Math.min(205, referenceGray - 20), gray };
    });
    const selected = scores.filter((score) => score.marked).sort((a, b) => a.gray - b.gray);
    answers.set(row.questionIndex, selected.map((score) => score.label).join("/"));
  });

  return answers;
}
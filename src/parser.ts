import { App, TFile, ListItemCache, CachedMetadata } from "obsidian";
import { ParsedTask, TaskStatus } from "./types";
import { extractMarkdownTags, stripMarkdownTags } from "./tags";

const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEADLINE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const CANCELLED_RE = /❌\s*(\d{4}-\d{2}-\d{2})/;
const CREATED_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
// US-406: accept optional callout prefix (`> ` or `>> ` etc. with
// interleaved whitespace) so tasks living inside Obsidian callouts are
// first-class citizens — parsed, rendered on the board, and written
// back correctly. Multi-level (`>>`) callout nesting is supported by
// the `(?:>\s*)*` repetition. Writer-side callout awareness lives in
// `src/writer.ts:setCheckbox` (callout-prefix-tolerant checkbox swap).
//
// US-125 task #33: trailing `\r?` before `$` strips the carriage return
// when the line came from CRLF input (paste from external source, copy
// from a browser tab, etc.). Without this, the `\r` would land inside
// the `content` capture group, taint the task's title hash, and the
// renderer's de-dup / children filter would silently drop the task.
// see USER_STORIES.md
const CHECKBOX_RE = /^(\s*(?:>\s*)*)([-+*])\s+\[(.)\]\s?(.*?)\r?$/;
// Strip emoji metadata, inline fields, tags, block anchors, and recurrence
// (`🔁 every week` style — consumed greedily to the next metadata boundary).
const META_STRIP_RE = /🔁\s*[^⏳📅🛫✅❌➕#[\]^]+|(⏳|📅|🛫|✅|❌|⌛|🔺|⏫|🔼|🔽|⏬|➕)\s*(\d{4}-\d{2}-\d{2})?/gu;
// US-108: inline-field syntax is `[fieldname:: value]` (Dataview-
// compatible). Field names are user data, not application knowledge, so
// cleanTitle strips every inline field from the rendered title while
// parseInlineFields preserves the exact field names for summaries.
// see USER_STORIES.md
const INLINE_FIELD_RE = /\[([^[\n:]+)::\s*([^\]]*)\]/g;
const INLINE_FIELD_STRIP_RE = /\[[^[\n:]+::\s*[^\]]*\]/g;
// US-142a: Priority emoji (Obsidian Tasks compatible): 🔺 highest,
// ⏫ high, 🔼 medium, 🔽 low, ⏬ lowest. Captured as a single-character
// field on ParsedTask; stripped from cleanTitle by META_STRIP_RE.
// see USER_STORIES.md
const PRIORITY_RE = /[🔺⏫🔼🔽⏬]/u;
// US-142a: Recurrence rule — 🔁 followed by a whitespace-separated
// description, consumed greedily up to the next known token boundary
// (another emoji field, an inline field, or end-of-line). The raw
// recurrence text is stored on ParsedTask for byte-preserving writes.
// see USER_STORIES.md
const RECURRENCE_RE = /🔁\s*(\S+(?:\s+\S+)*?)(?=\s*(?:⏳|📅|🛫|✅|❌|➕|[🔺⏫🔼🔽⏬]|\[|$))/u;
// Obsidian block reference anchors: `^blockid` at a word boundary
const BLOCK_REF_STRIP_RE = /(?:^|\s)\^[A-Za-z0-9_-]+(?=\s|$)/g;
const BLOCK_REF_WITH_HASH_STRIP_RE = /(?:^|\s)#\^[A-Za-z0-9_-]+(?=\s|$)/g;

export function parseDurationToMinutes(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  // "90m" / "1h30m" / "1.5h" / "90" (default minutes) / "2h" / "45min"
  let total = 0;
  const hMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
  if (hMatch) total += parseFloat(hMatch[1]) * 60;
  const mMatch = s.match(/(\d+(?:\.\d+)?)\s*m(?:in)?/);
  if (mMatch) total += parseFloat(mMatch[1]);
  if (total === 0) {
    const bare = s.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) total = parseFloat(bare[1]);
  }
  return total > 0 ? Math.round(total) : null;
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m - h * 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

export function parseInlineFields(content: string): {
  inlineFields: Record<string, string[]>;
  durationFields: Record<string, number>;
} {
  const inlineFields: Record<string, string[]> = {};
  const durationFields: Record<string, number> = {};
  let match: RegExpExecArray | null;
  INLINE_FIELD_RE.lastIndex = 0;
  while ((match = INLINE_FIELD_RE.exec(content)) !== null) {
    const name = match[1].trim();
    const value = match[2].trim();
    if (!name) continue;
    if (!inlineFields[name]) inlineFields[name] = [];
    inlineFields[name].push(value);
    const minutes = parseDurationToMinutes(value);
    if (minutes !== null) {
      durationFields[name] = (durationFields[name] ?? 0) + minutes;
    }
  }
  return { inlineFields, durationFields };
}

function inlineDateField(
  inlineFields: Record<string, string[]>,
  name: string,
): string | null {
  const value = inlineFields[name]?.find((candidate) => ISO_DATE_RE.test(candidate.trim()));
  return value?.trim() ?? null;
}

function priorityFromDataviewField(inlineFields: Record<string, string[]>): string | null {
  const value = inlineFields.priority?.find((candidate) => candidate.trim().length > 0)?.trim().toLowerCase();
  switch (value) {
    case "highest": return "🔺";
    case "high": return "⏫";
    case "medium": return "🔼";
    case "low": return "🔽";
    case "lowest": return "⏬";
    default: return null;
  }
}

export function parseTaskLine(line: string): {
  indent: string;
  marker: string;
  checkbox: string;
  content: string;
} | null {
  const m = CHECKBOX_RE.exec(line);
  if (!m) return null;
  return { indent: m[1], marker: m[2], checkbox: m[3], content: m[4] };
}

export function statusFromCheckbox(char: string): TaskStatus {
  switch (char) {
    case " ":
      return "todo";
    case "x":
    case "X":
      return "done";
    case "-":
      return "dropped";
    case "/":
      return "in_progress";
    case ">":
      return "cancelled";
    default:
      return "custom";
  }
}

export function shortHash(input: string): string {
  // Deterministic 12-char hash (FNV-1a-ish) to avoid crypto dep
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(16).padStart(8, "0");
  const lo = (h1 >>> 0).toString(16).padStart(8, "0");
  return (hi + lo).slice(0, 12);
}

export function cleanTitle(content: string): string {
  const withoutMetadata = content
    .replace(META_STRIP_RE, "")
    .replace(INLINE_FIELD_STRIP_RE, "")
    .replace(BLOCK_REF_WITH_HASH_STRIP_RE, " ")
    .replace(BLOCK_REF_STRIP_RE, " ");
  return stripMarkdownTags(withoutMetadata)
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTaskFromLine(
  path: string,
  lineNumber: number,
  rawLine: string,
  listItem: ListItemCache | null,
  mtime: number,
): ParsedTask | null {
  const parsed = parseTaskLine(rawLine);
  if (!parsed) return null;
  // US-107: ignore empty-title task lines. A checkbox with nothing
  // after it (or only whitespace) is not a real task — it's a
  // placeholder or an editing artifact.
  if (listItem && listItem.task === undefined) return null;
  if (parsed.content.trim().length === 0) return null;

  const content = parsed.content;
  const tagMatches = extractMarkdownTags(content);
  const { inlineFields, durationFields } = parseInlineFields(content);
  const emojiScheduled = content.match(SCHEDULED_RE)?.[1] ?? null;
  const emojiDeadline = content.match(DEADLINE_RE)?.[1] ?? null;
  const emojiStart = content.match(START_RE)?.[1] ?? null;
  const emojiCompleted = content.match(DONE_RE)?.[1] ?? null;
  const emojiCancelled = content.match(CANCELLED_RE)?.[1] ?? null;
  const emojiCreated = content.match(CREATED_RE)?.[1] ?? null;
  // US-142a: parse priority and recurrence from the raw content line
  // so they are available for writer byte-preservation and card rendering.
  const priority = content.match(PRIORITY_RE)?.[0] ?? priorityFromDataviewField(inlineFields);
  const recurrence = content.match(RECURRENCE_RE)?.[1]?.trim()
    ?? inlineFields.repeat?.find((candidate) => candidate.trim().length > 0)?.trim()
    ?? null;
  // US-406: calloutDepth counts `>` characters in the indent so the
  // writer can reconstruct the exact callout prefix when writing back.
  const calloutDepth = (parsed.indent.match(/>/g) || []).length;
  const scheduled = emojiScheduled ?? inlineDateField(inlineFields, "scheduled");
  const deadline = emojiDeadline ?? inlineDateField(inlineFields, "due");
  const start = emojiStart ?? inlineDateField(inlineFields, "start");
  const completed = emojiCompleted ?? inlineDateField(inlineFields, "completion");
  const cancelled = emojiCancelled ?? inlineDateField(inlineFields, "cancelled");
  const created = emojiCreated ?? inlineDateField(inlineFields, "created");
  const estimate = durationFields.estimate ?? null;
  const actual = durationFields.actual ?? null;

  const cleaned = cleanTitle(content);
  const status = statusFromCheckbox(parsed.checkbox);
  const hash = shortHash(`${path}::${cleaned}`);

  return {
    id: `${path}:L${lineNumber + 1}`,
    path,
    line: lineNumber,
    indent: parsed.indent,
    checkbox: parsed.checkbox,
    status,
    title: cleaned,
    rawTitle: content,
    rawLine,
    tags: tagMatches,
    scheduled,
    deadline,
    start,
    completed,
    cancelled,
    created,
    recurrence,
    priority,
    calloutDepth,
    inlineFields,
    durationFields,
    estimate,
    actual,
    parentLine: null,
    parentIndex: null,
    childrenLines: [],
    hash,
    mtime,
    inheritsTerminal: false,
    inheritedTerminalKind: null,
  };
}

function fencedCodeBoundary(line: string): { marker: "`" | "~"; length: number } | null {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const fence = match[1];
  return {
    marker: fence[0] as "`" | "~",
    length: fence.length,
  };
}

function parseRawFileTasks(
  path: string,
  lines: string[],
  mtime: number,
): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const byLine = new Map<number, ParsedTask>();
  const stack: Array<{ line: number; indentWidth: number }> = [];
  let openFence: { marker: "`" | "~"; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const fence = fencedCodeBoundary(lines[i]);
    if (
      fence &&
      (openFence === null ||
        (fence.marker === openFence.marker && fence.length >= openFence.length))
    ) {
      openFence = openFence === null ? fence : null;
      stack.length = 0;
      continue;
    }
    if (openFence) continue;

    const task = parseTaskFromLine(path, i, lines[i], null, mtime);
    if (!task) {
      if (lines[i].trim().length === 0) stack.length = 0;
      continue;
    }

    const indentWidth = task.indent.length;
    while (stack.length > 0 && stack[stack.length - 1].indentWidth >= indentWidth) {
      stack.pop();
    }
    const parentLine = stack.length > 0 ? stack[stack.length - 1].line : null;
    task.parentLine = parentLine;
    task.parentIndex = parentLine;
    if (parentLine !== null) {
      const parent = byLine.get(parentLine);
      if (parent) parent.childrenLines.push(i);
    }

    tasks.push(task);
    byLine.set(i, task);
    stack.push({ line: i, indentWidth });
  }

  return tasks;
}

export async function parseFileTasks(
  app: App,
  file: TFile,
  content?: string,
): Promise<ParsedTask[]> {
  const cache: CachedMetadata | null = app.metadataCache.getFileCache(file);
  const listItems = cache?.listItems;
  const raw = content ?? (await app.vault.cachedRead(file));
  // US-125 task #33: split on `\r?\n` so CRLF-terminated lines don't
  // carry a trailing `\r` into per-line parsing. Belt-and-suspenders
  // with CHECKBOX_RE's `\r?$` — either alone catches the bug, both
  // together survives any future intermediate transformation that
  // re-introduces CR.
  const lines = raw.split(/\r?\n/);
  const mtime = file.stat.mtime;
  const tasks: ParsedTask[] = [];

  if (listItems && listItems.length > 0) {
    const byLine = new Map<number, ParsedTask>();
    // Include non-task list items too so we can walk ancestor status / tags for
    // `inheritsTerminal` propagation through bullet-list section headers.
    interface AncestorNode {
      line: number;
      parentLine: number; // non-negative or -1 for root
      task: string | undefined; // checkbox char or undefined for bullets
      tags: string[];
      content: string;
    }
    const allNodes = new Map<number, AncestorNode>();
    for (const li of listItems) {
      const lineNum = li.position.start.line;
      const raw = lines[lineNum];
      if (raw === undefined) continue;
      // Extract content after bullet marker (for parsing tags on non-tasks too).
      const bulletMatch = raw.match(/^\s*[-+*]\s+(?:\[.\]\s*)?(.*)$/);
      const content = bulletMatch ? bulletMatch[1] : raw;
      const tags = extractMarkdownTags(content);
      const parent = li.parent !== undefined && li.parent >= 0 ? li.parent : -1;
      allNodes.set(lineNum, { line: lineNum, parentLine: parent, task: li.task, tags, content });

      if (li.task !== undefined) {
        const task = parseTaskFromLine(file.path, lineNum, raw, li, mtime);
        if (task) {
          task.parentIndex = li.parent;
          byLine.set(lineNum, task);
        }
      }
    }
    // Resolve parents/children among tasks only (for nested rendering)
    for (const [lineNum, task] of byLine) {
      if (task.parentIndex !== null && task.parentIndex !== undefined && task.parentIndex >= 0) {
        const parentLine = task.parentIndex;
        task.parentLine = parentLine;
        const parent = byLine.get(parentLine);
        if (parent) parent.childrenLines.push(lineNum);
      }
    }
    // Compute inheritsTerminal by walking ancestor chain through ALL list items.
    // Also record inheritedTerminalKind so EffectiveTask derivation can use the
    // correct terminal kind (done/dropped) even when the source is a non-task
    // bullet or section header.
    const terminalKind = (node: AncestorNode): TaskStatus | null => {
      if (node.task === "x" || node.task === "X") return "done";
      if (node.task === "-") return "dropped";
      if (node.tags.includes("#dropped")) return "dropped";
      return null;
    };
    for (const [, task] of byLine) {
      let cursor = task.parentIndex;
      const visited = new Set<number>();
      while (cursor !== null && cursor !== undefined && cursor >= 0) {
        if (visited.has(cursor)) break;
        visited.add(cursor);
        const node = allNodes.get(cursor);
        if (!node) break;
        const kind = terminalKind(node);
        if (kind !== null) {
          task.inheritsTerminal = true;
          task.inheritedTerminalKind = kind;
          break;
        }
        cursor = node.parentLine >= 0 ? node.parentLine : null;
      }
    }
    tasks.push(...Array.from(byLine.values()).sort((a, b) => a.line - b.line));
  } else {
    // Fallback: metadata is not indexed yet, so reconstruct the task tree
    // from raw Markdown instead of orphaning every indented task.
    tasks.push(...parseRawFileTasks(file.path, lines, mtime));
  }
  return tasks;
}

// `parseVaultTasks` was removed in Phase 1. Collection-level reads now live in
// `cache.ts/TaskCache.ensureAll`; this module exposes only per-line / per-file
// pure parsing primitives.

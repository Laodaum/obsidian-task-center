// Effective task tree — derivation of inherited fields, terminal cascade,
// top-level deduplication, and independent-date subtask breakout.
//
// Pure functions over ParsedTask[] → EffectiveTask[].  No DOM, no App,
// no Obsidian dependency.  View, CLI, and summary share this derivation
// before filtering/projection.
//
// ARCHITECTURE.md §1.2 defines EffectiveTask and the derivation rules;
// USER_STORIES.md frames the behaviour via US-143, US-144, US-144a,
// US-145, US-148, US-149.

import { ParsedTask, TaskStatus } from "./types";

// —————————————————————————————————————————————————————————————
// EffectiveTask — the derived view of a task after applying
// inheritance, terminal cascade, and display decisions.
// —————————————————————————————————————————————————————————————

export interface EffectiveTask extends ParsedTask {
  /** The status after applying terminal-inheritance from ancestors. */
  effectiveStatus: TaskStatus;
  /** ⏳ date after inheriting from the nearest scheduled ancestor. */
  effectiveScheduled: string | null;
  /** 📅 date after inheriting from the nearest ancestor that has one. */
  effectiveDeadline: string | null;
  /** ➕ date after inheriting from the nearest ancestor that has one. */
  effectiveCreated: string | null;
  /**
   * id of the terminal ancestor that caused effectiveStatus to be
   * done/dropped/cancelled. null when the task's own checkbox
   * determines effectiveStatus.
   */
  terminalInheritedFrom: string | null;
  /**
   * id of the parent task whose card this task should render inside,
   * or null when it should be a top-level card.
   */
  renderParentId: string | null;
  /**
   * true when this task appears as a top-level entry in the current
   * query result (either because it has no visible parent, or because
   * it was broken out for an independent date).
   */
  isTopLevelInQuery: boolean;
}

// —————————————————————————————————————————————————————————————
// Helper: build lookup maps
// —————————————————————————————————————————————————————————————

interface TaskNode {
  task: ParsedTask;
  children: ParsedTask[];
  parent: ParsedTask | null;
}

function taskLineKey(path: string, line: number): string {
  return `${path}:L${line + 1}`;
}

function parentKey(task: ParsedTask): string | null {
  if (task.parentLine === null || task.parentLine === undefined || task.parentLine < 0) {
    return null;
  }
  return taskLineKey(task.path, task.parentLine);
}

function buildTree(tasks: ParsedTask[]): Map<string, TaskNode> {
  const nodes = new Map<string, TaskNode>();

  for (const t of tasks) {
    nodes.set(t.id, { task: t, children: [], parent: null });
  }

  for (const [, node] of nodes) {
    const parentNode = nodes.get(parentKey(node.task) ?? "");
    if (parentNode) {
      node.parent = parentNode.task;
      parentNode.children.push(node.task);
    }
  }

  return nodes;
}

// —————————————————————————————————————————————————————————————
// US-144: Inheritance — child inherits undefined fields from
// the nearest ancestor that has a value.  Walk up the parent
// chain; stop at first own-value for each field independently.
// —————————————————————————————————————————————————————————————

function inheritFromAncestors(
  task: ParsedTask,
  nodeMap: Map<string, TaskNode>,
): {
  effectiveScheduled: string | null;
  effectiveDeadline: string | null;
  effectiveCreated: string | null;
} {
  let effectiveScheduled = task.scheduled;
  let effectiveDeadline = task.deadline;
  let effectiveCreated = task.created;

  let cursor = parentKey(task);
  while (cursor !== null) {
    const ancestor = nodeMap.get(cursor);
    if (!ancestor) break;
    const a = ancestor.task;
    if (effectiveScheduled === null && a.scheduled !== null) effectiveScheduled = a.scheduled;
    if (effectiveDeadline === null && a.deadline !== null) effectiveDeadline = a.deadline;
    if (effectiveCreated === null && a.created !== null) effectiveCreated = a.created;
    // Early exit: all three fields resolved
    if (effectiveScheduled !== null && effectiveDeadline !== null && effectiveCreated !== null) break;
    cursor = parentKey(a);
  }

  return { effectiveScheduled, effectiveDeadline, effectiveCreated };
}

// —————————————————————————————————————————————————————————————
// US-145 / US-144a: Terminal cascade — a done/dropped/cancelled
// ancestor makes all descendants inherit that terminal status.
// —————————————————————————————————————————————————————————————

const TERMINAL_STATUSES: Set<TaskStatus> = new Set(["done", "dropped", "cancelled"]);

function findTerminalAncestor(
  task: ParsedTask,
  nodeMap: Map<string, TaskNode>,
): { terminalId: string | null; terminalStatus: TaskStatus | null } {
  let cursor = parentKey(task);
  while (cursor !== null) {
    const ancestor = nodeMap.get(cursor);
    if (!ancestor) break;
    const a = ancestor.task;
    // US-144a: parent `[-]` dropped also terminates children.
    // When the ancestor carries inheritedTerminalKind (e.g. from a
    // non-task `#dropped` bullet), use that kind directly.
    if (TERMINAL_STATUSES.has(a.status) || a.inheritsTerminal) {
      let terminalStatus: TaskStatus;
      if (a.inheritedTerminalKind) {
        terminalStatus = a.inheritedTerminalKind;
      } else if (a.status === "todo" || a.status === "in_progress" || a.status === "custom") {
        terminalStatus = "done";
      } else {
        terminalStatus = a.status;
      }
      return {
        terminalId: a.id,
        terminalStatus,
      };
    }
    cursor = parentKey(a);
  }
  return { terminalId: null, terminalStatus: null };
}

// —————————————————————————————————————————————————————————————
// US-148 / US-149: Independent-date subtasks — when a child
// has its own ⏳ that differs from its effective parent's ⏳,
// the child is broken out as an independent top-level card
// in the date context that matches its own date.
// —————————————————————————————————————————————————————————————

function hasIndependentDate(
  task: ParsedTask,
  effectiveParentScheduled: string | null,
): boolean {
  // The child must have its own ⏳, and it must differ from the
  // inherited effective scheduled date.
  if (task.scheduled === null) return false;
  return task.scheduled !== effectiveParentScheduled;
}

// —————————————————————————————————————————————————————————————
// deriveEffectiveTasks — the main entry point.
// —————————————————————————————————————————————————————————————

export function deriveEffectiveTasks(tasks: ParsedTask[]): EffectiveTask[] {
  const nodes = buildTree(tasks);

  // Build set of all task ids for visibility lookups.
  const allIds = new Set(tasks.map((t) => t.id));

  // Pre-compute inheritance and terminal cascade for every task.
  const inherited = new Map<string, {
    effectiveScheduled: string | null;
    effectiveDeadline: string | null;
    effectiveCreated: string | null;
  }>();
  const terminal = new Map<string, {
    terminalId: string | null;
    terminalStatus: TaskStatus | null;
  }>();

  for (const t of tasks) {
    inherited.set(t.id, inheritFromAncestors(t, nodes));
    terminal.set(t.id, findTerminalAncestor(t, nodes));
  }

  // Phase 1: compute effectiveStatus.
  // Phase 2: determine renderParentId and isTopLevelInQuery.
  const effective: EffectiveTask[] = [];

  for (const t of tasks) {
    const inh = inherited.get(t.id)!;
    const term = terminal.get(t.id)!;

    // effectiveStatus: first check if a task ancestor is terminal;
    // if not, check if the task itself carries inheritedTerminalKind
    // from a non-task ancestor (e.g. `#dropped` section header).
    let effectiveStatus: TaskStatus;
    let terminalInheritedFrom: string | null;
    if (term.terminalStatus !== null) {
      effectiveStatus = term.terminalStatus;
      terminalInheritedFrom = term.terminalId;
    } else if (t.inheritedTerminalKind) {
      effectiveStatus = t.inheritedTerminalKind;
      // Non-task source — point to self as the carrier.
      terminalInheritedFrom = t.id;
    } else {
      effectiveStatus = t.status;
      terminalInheritedFrom = null;
    }

    const eft: EffectiveTask = {
      ...t,
      effectiveStatus,
      effectiveScheduled: inh.effectiveScheduled,
      effectiveDeadline: inh.effectiveDeadline,
      effectiveCreated: inh.effectiveCreated,
      terminalInheritedFrom,
      renderParentId: null,
      isTopLevelInQuery: false,
    };

    effective.push(eft);
  }

  // Phase 2: resolve renderParentId and independent-date breakout.
  // We rebuild a node map from EffectiveTasks so we can walk the
  // parent chain.
  const effNodeMap = new Map<string, {
    task: EffectiveTask;
    parent: EffectiveTask | null;
  }>();
  for (const e of effective) {
    effNodeMap.set(e.id, { task: e, parent: null });
  }
  for (const [, node] of effNodeMap) {
    const parentNode = effNodeMap.get(parentKey(node.task) ?? "");
    if (parentNode) node.parent = parentNode.task;
  }

  for (const e of effective) {
    // Find the closest visible ancestor.
    let renderParentId: string | null = null;
    let cursor = parentKey(e);
    while (cursor !== null) {
      const ancestorNode = effNodeMap.get(cursor);
      if (!ancestorNode) break;
      const ancestor = ancestorNode.task;
      if (allIds.has(ancestor.id)) {
        renderParentId = ancestor.id;
        break;
      }
      cursor = parentKey(ancestor);
    }
    e.renderParentId = renderParentId;

    // Determine if this task is top-level.
    // It is top-level when:
    //   1. It has NO visible parent (renderParentId is null), OR
    //   2. It has an independent date from its effective parent ⏳
    //      (US-148 / US-149 breakout).
    if (renderParentId === null) {
      e.isTopLevelInQuery = true;
    } else {
      // Check independent-date breakout.
      const parentEff = effective.find((p) => p.id === renderParentId);
      if (parentEff && hasIndependentDate(e, parentEff.effectiveScheduled)) {
        // Break out: this child appears as its own top-level card
        // in the date context matching its own ⏳.
        e.isTopLevelInQuery = true;
        // Clear renderParentId so the rendering layer doesn't nest it.
        e.renderParentId = null;
      } else {
        e.isTopLevelInQuery = false;
      }
    }
  }

  return effective;
}

/**
 * Count top-level tasks from an EffectiveTask array — used for the
 * tab badge number which must count visible top-level cards, not
 * the raw task count (US-143 prevents double-counting parent-visible
 * children).
 */
export function countTopLevel(tasks: EffectiveTask[]): number {
  return tasks.filter((t) => t.isTopLevelInQuery).length;
}

/**
 * Recompute isTopLevelInQuery after query filtering.
 *
 * `deriveEffectiveTasks` computes isTopLevelInQuery from the full vault
 * task set. After applying query filters, some parent tasks may be
 * removed. Children whose parent was filtered out must become top-level
 * so they remain visible (their parent is not in the filtered result).
 *
 * Conversely, children whose parent IS still in the filtered result
 * must remain nested (isTopLevelInQuery=false).
 *
 * This is a pure function — it returns a new array without mutating inputs.
 */
export function recomputeTopLevelInQuery(
  filtered: EffectiveTask[],
): EffectiveTask[] {
  const filteredIds = new Set(filtered.map((t) => t.id));

  return filtered.map((t) => {
    // Already top-level → keep as-is.
    if (t.isTopLevelInQuery) return t;

    // Child whose renderParentId is NOT in the filtered set:
    // the parent was removed by the query filter, so this child
    // must appear as a top-level card.
    if (t.renderParentId === null || !filteredIds.has(t.renderParentId)) {
      return { ...t, isTopLevelInQuery: true, renderParentId: null };
    }

    // Child whose parent IS still visible → stays nested.
    return t;
  });
}

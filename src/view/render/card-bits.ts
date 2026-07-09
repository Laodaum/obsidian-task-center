// Small, zero-state card DOM helpers extracted from TaskCenterView toward the
// CardRenderPort split (ARCHITECTURE §7.7). Pure DOM construction, no view
// state — this file grows as `view/render/card.ts` is carved out.

import { taskDisplayTags } from "../../tags";

// Render the original (display-filtered) hashtags below a card title.
export function renderTaskTags(parent: HTMLElement, tags: string[], extraClass: string): void {
  const displayTags = taskDisplayTags(tags);
  if (displayTags.length === 0) return;
  const row = parent.createDiv({ cls: `bt-task-tags ${extraClass}` });
  for (const tag of displayTags) {
    row.createSpan({ cls: "bt-task-tag", text: tag });
  }
}

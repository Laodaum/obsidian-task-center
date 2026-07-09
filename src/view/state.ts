import type { SavedViewStatus, SavedViewTimeField, SavedViewTimeFilters } from "../types";

export type TabKey = "today" | "week" | "month" | "completed" | "unscheduled" | "list" | "matrix" | "horizon";
export type FilterPopoverKey = "view" | "tag" | "status" | "time-more" | `time:${SavedViewTimeField}`;

export interface ViewState {
  tab: TabKey;
  anchorISO: string;
  selectedTaskId: string | null;
  filter: string;
  savedViewId: string | null;
  savedViewTag: string;
  savedViewTime: SavedViewTimeFilters;
  savedViewStatus: SavedViewStatus;
  showUnscheduledPool: boolean;
  collapsedWeeks: Set<string>;
  expandedDays: Set<string>;
  selectedMonthDay: string | null;
}

import type { QueryStatus, QueryTimeField, QueryTimeFilters } from "../types";

export type TabKey = "today" | "week" | "month" | "completed" | "unscheduled" | "list";
export type FilterPopoverKey = "view" | "tag" | "status" | "time-more" | `time:${QueryTimeField}`;

export interface ViewState {
  tab: TabKey;
  anchorISO: string;
  selectedTaskId: string | null;
  filter: string;
  savedViewId: string | null;
  savedViewTag: string;
  savedViewTime: QueryTimeFilters;
  savedViewStatus: QueryStatus;
  showUnscheduledPool: boolean;
  collapsedWeeks: Set<string>;
  expandedDays: Set<string>;
  selectedMonthDay: string | null;
}

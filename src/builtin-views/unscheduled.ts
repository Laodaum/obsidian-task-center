export default {
  filters: { status: ["todo"] },
  view: { type: "list", preset: "unscheduled", orderBy: ["deadline_risk", "created_desc"] },
  summary: [{ type: "count" }],
};

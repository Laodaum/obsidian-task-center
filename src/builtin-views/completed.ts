export default {
  filters: { status: ["done"] },
  view: { type: "list", preset: "completed", orderBy: ["completed_desc"] },
  summary: [
    { type: "count" },
    { type: "sum", field: "actual", format: "duration" },
    { type: "ratio", numerator: "actual", denominator: "estimate", format: "percent" },
  ],
};

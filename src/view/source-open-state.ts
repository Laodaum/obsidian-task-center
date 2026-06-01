export type MarkdownSourceOpenState = {
  active: boolean;
  state: { line: number };
  eState: { line: number };
};

export function markdownSourceOpenState(line: number, active: boolean): MarkdownSourceOpenState {
  return {
    active,
    state: { line },
    eState: { line },
  };
}

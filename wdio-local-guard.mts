export function assertE2eRunsOnlyInCi(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  if (env.GITHUB_ACTIONS === "true") return;

  const platformLabel = platform === "darwin" ? "macOS" : platform;
  throw new Error(
    `Local e2e is disabled on ${platformLabel}. Run WebDriverIO e2e only in GitHub Actions CI.`,
  );
}

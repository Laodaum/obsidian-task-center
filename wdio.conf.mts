import * as path from "path";
import dns from "node:dns";
import { parseObsidianVersions, obsidianBetaAvailable } from "wdio-obsidian-service";
import { env, platform } from "process";
import { assertE2eRunsOnlyInCi } from "./wdio-local-guard.mts";
import { pickWdioVersions } from "./wdio-versions.mts";

assertE2eRunsOnlyInCi(env, platform);

// The remote BYOI gate pod resolves AAAA records but has no IPv6 route, so an
// IPv6-first connect wastes the first attempt on ENETUNREACH. Prefer IPv4 for
// the load-time `obsidianBetaAvailable -> getVersions` fetch below (and any
// child). The metadata cache is pre-warmed by `e2e:prefetch`, so this fetch
// normally hits the on-disk cache; IPv4-first just removes one failure surface.
dns.setDefaultResultOrder("ipv4first");

const cacheDir = path.resolve(".obsidian-cache");

// task #45 (US-602): default to the stable matrix only; beta is opt-in
// via `OBSIDIAN_USE_BETA=1`. See wdio-versions.mts for rationale.
const betaCached = await obsidianBetaAvailable({ cacheDir });
const defaultVersions = pickWdioVersions(env, betaCached);
const desktopVersions = await parseObsidianVersions(defaultVersions, { cacheDir });
if (env.CI) {
  console.log("obsidian-cache-key:", JSON.stringify([desktopVersions]));
}

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./test/e2e/specs/**/*.e2e.ts"],

  // task #48 (0.3.x): default to 1 worker. The service copies the vault per
  // worker (`reloadObsidian` default `copy: true`), so vault FILES are already
  // isolated across workers — but `obsidianPage.resetVault` does NOT reset
  // `.obsidian` plugin settings, so a spec that flips `taskFormatFlavor` leaks
  // it into siblings. That shared *settings* state, plus `resetVault` racing
  // concurrent `metadataCache.changed`, is what made parallel runs flaky (the
  // subtask and mobile-coverage specs were the canaries). New flavor-sensitive
  // specs self-isolate via `_journeys.resetForWriteFlavor` (vault reset + setting
  // write each beforeEach); see docs/ci-test-matrix.md "Test isolation &
  // parallelism" for the path to safely raising this default. Until a maintainer
  // collects multi-run flake evidence, the gate stays serial. Opt back into
  // parallel with `WDIO_MAX_INSTANCES=2 pnpm test:e2e`.
  maxInstances: Number(env.WDIO_MAX_INSTANCES || 1),

  capabilities: desktopVersions.map<WebdriverIO.Capabilities>(
    ([appVersion, installerVersion]) => ({
      browserName: "obsidian",
      "wdio:obsidianOptions": {
        appVersion,
        installerVersion,
        plugins: ["."],
        vault: "test/e2e/vaults/simple",
      },
    }),
  ),

  services: ["obsidian"],
  reporters: ["obsidian"],

  mochaOpts: {
    ui: "bdd",
    timeout: 60 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 5 * 1000,
  logLevel: "warn",

  cacheDir,

  injectGlobals: false,
};

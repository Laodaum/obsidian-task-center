// Pre-warm the Obsidian asset cache before `wdio run` so the e2e gate never
// dies on a single un-retried network blip.
//
// Root cause (remote BYOI gate pod):
//   The formal gate runs inside an internal k3s pod whose IPv4 egress to
//   GitHub/Fastly (raw.githubusercontent.com) and the npm registry suffers
//   *intermittent* TLS-handshake-phase RSTs ("Client network socket
//   disconnected before secure TLS connection was established", ECONNRESET), and
//   the pod resolves AAAA records but has no IPv6 route (an IPv6-first connect
//   wastes the first attempt on ENETUNREACH). `pnpm install` survives because
//   pnpm retries; the e2e step did NOT, because the very first thing
//   wdio.conf.mts does at config-load is a single, un-retried
//   `obsidianBetaAvailable -> getVersions -> cachedFetch` against
//   raw.githubusercontent.com. One unlucky RST there killed the whole gate at
//   config-load time, before any spec ran.
//
// Fix: run this prefetch first, IPv4-first and with retry/backoff. It writes a
// fresh `obsidian-versions.json` into `.obsidian-cache` (the same cacheDir
// wdio.conf uses) and pre-downloads the Obsidian app / installer / chromedriver
// for the exact versions wdio will request. obsidian-launcher's `cachedFetch`
// then serves wdio.conf's load-time `getVersions` straight from the fresh cache
// (default 30-min cacheDuration -> no network at all), and even past that it
// falls back to the cached file on a fetch error. Test-time runs offline against
// the warmed cache. The full e2e suite still runs against the same
// `OBSIDIAN_VERSIONS` — coverage is unchanged, only the failure mode is fixed.

import dns from "node:dns";
// Affects this process (and the in-process obsidian-launcher fetches below); the
// pod's AAAA-without-route black-hole otherwise wastes the first connect.
dns.setDefaultResultOrder("ipv4first");

// obsidian-launcher's large binary download streams via undici; a mid-stream RST
// surfaces as an *unhandled* `TypeError: terminated` that escapes the awaited
// promise (so withRetry can't see it). Convert it to a clean non-zero exit so
// the shell-level retry in `test:e2e:ci` re-runs the whole prefetch.
process.on("unhandledRejection", (err) => {
  console.error("[e2e-prefetch] unhandledRejection (likely a mid-download socket RST):", err);
  process.exit(1);
});

import * as path from "node:path";
import { env } from "node:process";
import ObsidianLauncher from "obsidian-launcher";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { pickWdioVersions } from "./wdio-versions.mts";

const cacheDir = path.resolve(".obsidian-cache");
const launcher = new ObsidianLauncher({ cacheDir });

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === attempts) {
        throw new Error(`[e2e-prefetch] ${label} failed after ${attempts} attempts: ${(err as Error).message}`);
      }
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      console.warn(
        `[e2e-prefetch] ${label} attempt ${attempt} failed (${(err as Error).message}); retrying in ${backoff}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw new Error("unreachable");
}

// 1) Prime obsidian-versions.json — this is exactly what wdio.conf's load-time
//    getVersions needs; once it is on disk and fresh, config-load does no fetch.
await withRetry("getVersions", () => launcher.getVersions());

// 2) Resolve the same versions wdio.conf will request and pre-download their
//    binaries so the test phase needs no network at all.
const spec = (env.OBSIDIAN_VERSIONS || pickWdioVersions(env, false)).trim();
const versions = await withRetry("parseObsidianVersions", () => parseObsidianVersions(spec, { cacheDir }));

for (const [appVersion, installerVersion] of versions) {
  console.log(`[e2e-prefetch] caching Obsidian app ${appVersion} / installer ${installerVersion} into ${cacheDir}`);
  await withRetry(`installer ${installerVersion}`, () => launcher.downloadInstaller(installerVersion));
  await withRetry(`app ${appVersion}`, () => launcher.downloadApp(appVersion));
  await withRetry(`chromedriver ${installerVersion}`, () => launcher.downloadChromedriver(installerVersion));
}

console.log(`[e2e-prefetch] Obsidian assets cached for: ${spec}`);

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Release-train version-parity check (#894, the structural fix for #203's class).
 *
 *   The demo repoint is DELIBERATELY a separate step from the npm publish (mailwoman-release
 *   Step 5), so demo-vs-npm drift is structural, not accidental — which is why this check must be
 *   structural too. #203 (demo silently two model versions behind npm) was fixed as an instance;
 *   this script fails the day the drift reappears, anywhere it can appear:
 *
 *   1. The demo's live manifest (`releases.json` `defaultVersion` on the public R2 bucket — the
 *      exact URL the demo fetches) vs the latest published npm version.
 *   2. The docs release matrix (`docs/articles/releases.mdx` "(current)" row) vs the same npm
 *      version — the row went stale twice (v4.11.0 era, then again within hours of v5.1.0).
 *
 *   Run by `.github/workflows/version-parity.yml` (daily + manual dispatch). Zero workspace
 *   dependencies on purpose: plain built-ins, so CI needs no yarn install. `--warn-only`
 *   downgrades mismatches to warnings (useful mid-release, before the repoint lands).
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const NPM_REGISTRY_URL = "https://registry.npmjs.org/mailwoman"
// The demo's own fetch path (docs/src/contexts/DemoEmbed.tsx) — check what the demo actually reads,
// not what the publisher believes it wrote.
const DEMO_MANIFEST_URL = "https://public.sister.software/mailwoman/en-us/releases.json"

const RELEASES_MDX_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "articles", "releases.mdx")

interface ParityCheck {
	name: string
	value: string
	ok: boolean
}

/** Strip a leading `v` so demo-manifest versions (`v5.1.0`) compare against npm versions (`5.1.0`). */
function normalizeVersion(version: string): string {
	return version.replace(/^v/, "").trim()
}

async function fetchJSON(url: string): Promise<Record<string, unknown>> {
	const res = await fetch(url, { headers: { accept: "application/json" } })

	if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)

	return (await res.json()) as Record<string, unknown>
}

async function readNPMLatest(): Promise<string> {
	const pkg = await fetchJSON(NPM_REGISTRY_URL)
	const distTags = pkg["dist-tags"] as Record<string, string> | undefined
	const latest = distTags?.latest

	if (!latest) throw new Error(`npm registry response for mailwoman has no dist-tags.latest`)

	return normalizeVersion(latest)
}

async function readDemoDefaultVersion(): Promise<string> {
	const manifest = await fetchJSON(DEMO_MANIFEST_URL)
	const defaultVersion = manifest.defaultVersion

	if (typeof defaultVersion !== "string" || !defaultVersion) {
		throw new Error(`${DEMO_MANIFEST_URL} has no string defaultVersion`)
	}

	return normalizeVersion(defaultVersion)
}

function readDocsCurrentVersion(): string {
	const mdx = readFileSync(RELEASES_MDX_PATH, "utf8")
	const match = mdx.match(/^\|\s*\*\*([\d.]+)\*\*\s*\(current\)/m)

	if (!match) throw new Error(`${RELEASES_MDX_PATH} has no "| **X.Y.Z** (current)" row`)

	return normalizeVersion(match[1])
}

const warnOnly = process.argv.includes("--warn-only")

const npmLatest = await readNPMLatest()
const checks: ParityCheck[] = []

const demoDefault = await readDemoDefaultVersion()
checks.push({ name: `demo manifest defaultVersion (${DEMO_MANIFEST_URL})`, value: demoDefault, ok: demoDefault === npmLatest })

const docsCurrent = readDocsCurrentVersion()
checks.push({ name: "docs/articles/releases.mdx (current) row", value: docsCurrent, ok: docsCurrent === npmLatest })

console.log(`npm dist-tags.latest: ${npmLatest}\n`)

let failed = false

for (const check of checks) {
	const mark = check.ok ? "✓" : warnOnly ? "⚠" : "✗"

	if (!check.ok) failed = true
	console.log(`${mark} ${check.name}: ${check.value}${check.ok ? "" : ` (expected ${npmLatest})`}`)
}

if (failed && !warnOnly) {
	console.error(
		`\nVersion parity FAILED — a surface trails npm ${npmLatest}. Repoint the demo (mailwoman-release Step 5) ` +
			`and/or update the releases.mdx (current) row. See #894 / #203.`
	)
	process.exit(1)
}

console.log(failed ? "\nDrift present (warn-only mode)." : "\nAll release surfaces in parity.")

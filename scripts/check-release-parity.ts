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
import { parseArgs } from "node:util"

import { repoRootPath } from "@mailwoman/core/utils"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { "warn-only": { type: "boolean" } },
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { "warn-only"?: boolean }
const NPM_REGISTRY_URL = "https://registry.npmjs.org/mailwoman"
// The demo's own fetch path (docs/src/contexts/DemoEmbed.tsx) — check what the demo actually reads,
// not what the publisher believes it wrote.
const DEMO_MANIFEST_URL = "https://public.sister.software/mailwoman/en-us/releases.json"

const RELEASES_MDX_PATH = repoRootPath("docs", "articles", "releases.mdx")
const MODEL_CARD_PATH = repoRootPath("neural-weights-en-us", "model-card.json")

interface ParityCheck {
	name: string
	value: string
	ok: boolean
	/** What the value was compared against — printed on failure. */
	expected: string
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
	const version = mdx.match(/^\|\s*\*\*([\d.]+)\*\*\s*\(current\)/m)?.[1]

	if (!version) throw new Error(`${RELEASES_MDX_PATH} has no "| **X.Y.Z** (current)" row`)

	return normalizeVersion(version)
}

const warnOnly = values["warn-only"] ?? false

const npmLatest = await readNPMLatest()
const checks: ParityCheck[] = []

// TWO VERSION SERIES (2026-07-23 realignment — see releases.mdx's "Two version series" intro):
// the demo serves MODELS, so its `defaultVersion` carries the model-card lineage number (6.6.0),
// not the npm package number — comparing it against npm latest went permanently red the moment a
// code-only release shipped (daily failures 07-21→07-23 across v7.3–v7.5). The demo leg now
// compares against the SHIPPED model identity: `neural-weights-en-us/model-card.json#version`
// (the same source verify-release-metadata keys off). The docs matrix row stays vs npm latest —
// that surface documents package releases.
const cardModelVersion = normalizeVersion(
	(JSON.parse(readFileSync(MODEL_CARD_PATH, "utf8")) as { version: string }).version
)

const demoDefault = await readDemoDefaultVersion()
checks.push({
	name: `demo manifest defaultVersion (${DEMO_MANIFEST_URL})`,
	value: demoDefault,
	ok: demoDefault === cardModelVersion,
	expected: `${cardModelVersion} (model-card version)`,
})

const docsCurrent = readDocsCurrentVersion()
checks.push({
	name: "docs/articles/releases.mdx (current) row",
	value: docsCurrent,
	ok: docsCurrent === npmLatest,
	expected: npmLatest,
})

console.log(`npm dist-tags.latest: ${npmLatest} · shipped model (card): ${cardModelVersion}\n`)

let failed = false

for (const check of checks) {
	const mark = check.ok ? "✓" : warnOnly ? "⚠" : "✗"

	if (!check.ok) {
		failed = true
	}
	console.log(`${mark} ${check.name}: ${check.value}${check.ok ? "" : ` (expected ${check.expected})`}`)
}

if (failed && !warnOnly) {
	console.error(
		`\nVersion parity FAILED — a surface trails npm ${npmLatest}. Repoint the demo (mailwoman-release Step 5) ` +
			`and/or update the releases.mdx (current) row. See #894 / #203.`
	)
	process.exit(1)
}

console.log(failed ? "\nDrift present (warn-only mode)." : "\nAll release surfaces in parity.")

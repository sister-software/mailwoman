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
 *   this operation fails the day the drift reappears, anywhere it can appear:
 *
 *   1. The demo's live manifest (`releases.json` `defaultVersion` on the public R2 bucket — the
 *      exact URL the demo fetches) vs the latest published npm version.
 *   2. The docs release matrix (`docs/records/site-2026-08/releases.mdx` "(current)" row) vs the same npm
 *      version — the row went stale twice (v4.11.0 era, then again within hours of v5.1.0).
 *
 *   Run by `.github/workflows/version-parity.yml` (daily + manual dispatch), AFTER its install step —
 *   this module reaches `@mailwoman/core` plus the shared releases-matrix parser in
 *   `verify-metadata.ts`. `warnOnly` downgrades mismatches to warnings (useful mid-release, before
 *   the repoint lands).
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { currentMatrixVersion } from "#release/verify-metadata"

const NPM_REGISTRY_URL = "https://registry.npmjs.org/mailwoman"
/**
 * The demo's own fetch path (docs/src/contexts/DemoEmbed.tsx) — check what the demo actually reads, not what the
 * publisher believes it wrote.
 */
const DEMO_MANIFEST_URL = "https://public.mailwoman.ai/mailwoman/en-us/releases.json"

export interface ParityCheck {
	name: string
	value: string
	ok: boolean
	/**
	 * What the value was compared against — printed on failure.
	 */
	expected: string
}

export interface ReleaseParityReport {
	npmLatest: string
	cardModelVersion: string
	checks: ParityCheck[]
	/**
	 * True when a check failed and `warnOnly` let the run finish.
	 */
	drift: boolean
}

/**
 * Strip a leading `v` so demo-manifest versions (`v5.1.0`) compare against npm versions (`5.1.0`).
 */
function normalizeVersion(version: string): string {
	return version.replace(/^v/, "").trim()
}

/**
 * The parity checker's HTTP client.
 *
 * Retry is ON because every host this talks to rate-limits: the npm registry, the demo manifest bucket, and Hugging
 * Face. A release check that fails because a registry throttled it reads exactly like a release check that failed
 * because a surface trails, and the second one is the only kind anybody should act on.
 */
function createParityClient(): APIClient {
	return new APIClient({
		displayName: "release-parity",
		retry: true,
		axios: { headers: { accept: "application/json" } },
	})
}

export interface CheckReleaseParityOptions {
	repoRoot: string
	warnOnly: boolean
	log: (line: string) => void
}

export async function checkReleaseParity(options: CheckReleaseParityOptions): Promise<ReleaseParityReport> {
	const { repoRoot, warnOnly, log } = options
	const releasesMDXPath = resolvePath(repoRoot, "docs", "records", "site-2026-08", "releases.mdx")
	const modelCardPath = resolvePath(repoRoot, "packages", "neural-weights-en-us", "model-card.json")
	const parityClient = createParityClient()

	const fetchJSON = (url: string): Promise<Record<string, unknown>> =>
		parityClient.fetch<Record<string, unknown>>({ url }).then(pluckResponseData)

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

	async function readDocsCurrentVersion(): Promise<string> {
		const mdx = await readLocalTextFile(releasesMDXPath)
		const version = currentMatrixVersion(mdx)

		if (!version) throw new Error(`${releasesMDXPath} has no "| **X.Y.Z** (current)" row`)

		return normalizeVersion(version)
	}

	const npmLatest = await readNPMLatest()
	const checks: ParityCheck[] = []

	// TWO VERSION SERIES (see releases.mdx's "Two version series" intro): the demo serves MODELS, so its
	// `defaultVersion` carries the model-card lineage number, not the npm package number — comparing it
	// against npm latest went permanently red the moment a code-only release shipped. The demo leg
	// compares against the SHIPPED model identity: `packages/neural-weights-en-us/model-card.json#version`
	// (the same source verify-metadata keys off). The docs matrix row stays vs npm latest — that surface
	// documents package releases.
	const localCard = await readLocalJSONFile<{
		version: string
		files_md5?: Record<string, string>
	}>(modelCardPath)

	const cardModelVersion = normalizeVersion(localCard.version)

	const demoDefault = await readDemoDefaultVersion()

	// The demo's parity contract is MODEL BYTES, not the bundle number. Bundle revisions that change only
	// decode-side artifacts move the card version with ZERO model.onnx change — the demo serving the
	// previous bundle serves the IDENTICAL model, and can't even use the new artifacts until neural-web
	// grows pair-prior wiring (#1278). So a trailing defaultVersion passes IFF the trailing version's
	// shipped card records the same `files_md5["model.onnx"]` as the current card (fetched from the HF
	// bucket — the same store the demo loads from). Different bytes = real drift = fail.
	let demoOK = demoDefault === cardModelVersion
	let demoNote = `${cardModelVersion} (model-card version)`

	if (!demoOK && localCard.files_md5?.["model.onnx"]) {
		try {
			const trailingCardURL = `https://huggingface.co/buckets/sister-software/mailwoman/resolve/en-us/v${demoDefault}/model-card.json`

			const trailingCard = (await fetchJSON(trailingCardURL)) as {
				files_md5?: Record<string, string>
			}

			if (trailingCard.files_md5?.["model.onnx"] === localCard.files_md5["model.onnx"]) {
				demoOK = true
				demoNote = `${cardModelVersion} — demo trails on a bundle revision with IDENTICAL model bytes (model.onnx md5 match); acceptable until the demo repoint (#1278)`

				log(
					`  note: demo defaultVersion ${demoDefault} trails card ${cardModelVersion} but model.onnx bytes are identical — bundle-only revision, parity holds`
				)
			}
		} catch {
			// Fetch failure → keep the strict verdict rather than silently passing.
		}
	}

	checks.push({
		name: `demo manifest defaultVersion (${DEMO_MANIFEST_URL})`,
		value: demoDefault,
		ok: demoOK,
		expected: demoNote,
	})

	const docsCurrent = await readDocsCurrentVersion()

	checks.push({
		name: "docs/records/site-2026-08/releases.mdx (current) row",
		value: docsCurrent,
		ok: docsCurrent === npmLatest,
		expected: npmLatest,
	})

	log(`npm dist-tags.latest: ${npmLatest} · shipped model (card): ${cardModelVersion}\n`)

	let failed = false

	for (const check of checks) {
		const mark = check.ok ? "✓" : warnOnly ? "⚠" : "✗"

		if (!check.ok) {
			failed = true
		}

		log(`${mark} ${check.name}: ${check.value}${check.ok ? "" : ` (expected ${check.expected})`}`)
	}

	if (failed && !warnOnly) {
		throw new Error(
			`Version parity FAILED — a surface trails npm ${npmLatest}. Repoint the demo (mailwoman-release Step 5) ` +
				`and/or update the releases.mdx (current) row. See #894 / #203.`
		)
	}

	log(failed ? "\nDrift present (warn-only mode)." : "\nAll release surfaces in parity.")

	return { npmLatest, cardModelVersion, checks, drift: failed }
}

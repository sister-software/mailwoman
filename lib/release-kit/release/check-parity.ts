/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Release-train version-parity check.
 *
 *   The demo repoint is a separate step from the npm publish (mailwoman-release Step 5), so
 *   demo-vs-npm drift is structural. This check is structural too. It fails when a surface trails
 *   npm, anywhere it can appear:
 *
 *   1. The demo's live manifest (`releases.json` `defaultVersion` on the public R2 bucket, the
 *      exact URL the demo fetches) against the latest published npm version.
 *   2. The docs release matrix (`docs/engineering/releases.mdx` "(current)" row) against the same
 *      npm version.
 *
 *   Run by `.github/workflows/version-parity.yml` (daily + manual dispatch), after its install step.
 *   This module reaches `@mailwoman/core` plus the shared releases-matrix parser in
 *   `verify-metadata.ts`. `warnOnly` downgrades mismatches to warnings (useful mid-release, before
 *   the repoint lands).
 */

import { APIClient, pluckResponseData } from "@mailwoman/core/api"
import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { currentMatrixVersion } from "#release-kit/release/verify-metadata"

const NPM_REGISTRY_URL = "https://registry.npmjs.org/mailwoman"
/**
 * The browser runtime's own fetch path (`mailwoman/browser-runtime/manifest`,
 * mounted by docs/src/contexts/RuntimeEmbed.tsx and the Earth app).
 */
const DEMO_MANIFEST_URL = "https://public.mailwoman.ai/mailwoman/en-us/releases.json"

export interface ParityCheck {
	name: string
	value: string
	ok: boolean
	/**
	 * What the value was compared against, printed on failure.
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
 * The parity checker's http client.
 *
 * Retry is on because every host this talks to rate-limits: the npm registry,
 * the demo manifest bucket and Hugging Face.
 * A throttled registry and a trailing release surface produce the same failure result.
 * Only a trailing surface requires release action.
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
	const releasesMDXPath = resolvePath(repoRoot, "docs", "engineering", "releases.mdx")
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

	// Two version series (see releases.mdx's "Two version series" intro).
	// The demo serves models, so its `defaultVersion` records the model-card lineage number.
	// The demo leg compares that against the shipped model identity in
	// `packages/neural-weights-en-us/model-card.json#version` (the same source verify-metadata keys off).
	// The docs matrix row stays vs npm latest, since that surface documents package releases.
	const localCard = await readLocalJSONFile<{
		version: string
		files_md5?: Record<string, string>
	}>(modelCardPath)

	const cardModelVersion = normalizeVersion(localCard.version)

	const demoDefault = await readDemoDefaultVersion()

	// The demo's parity interface is model bytes.
	// Bundle revisions that change only decode-side artifacts move the card
	// version with zero model.onnx change.
	// The demo serving the previous bundle serves the identical model and cannot use
	// the new artifacts until the web loader grows pair-prior wiring.
	// So a trailing defaultVersion passes when the trailing version's shipped card
	// records the same `files_md5["model.onnx"]` as the current card, fetched from
	// the HF bucket (the same store the demo loads from).
	// Different bytes means real drift.
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
			// A fetch failure keeps the strict verdict.
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
		name: "docs/engineering/releases.mdx (current) row",
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

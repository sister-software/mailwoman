/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The parity-corpus eval (#1093) — the rescued v1 hand-written gold (354 live fixtures across 20
 *   countries) scored against a checkpoint, parse-only. This is the model campaign's gate for the
 *   HELD plan-2 swaps: the per-label floors below are the SAME pre-registered floors the swap gates
 *   carry (house_number ≥ 0.97, postcode ≥ 0.97, street-family ≥ 0.90 — never edited to green; a
 *   miss is an adjudication). Comparison is case-folded, whitespace-collapsed; the street label
 *   compares the assembled neural street-name family against the gold `street` values.
 */

import { readFileSync } from "node:fs"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import type { ParityFixture } from "../dev-tools/convert-parity-fixtures.run.ts"

export const PARITY_FIXTURES_PATH = "mailwoman/eval-harness/fixtures/parity-corpus.jsonl"

/** Pre-registered floors (plan 2, 2026-07-13). Shared verbatim with the held swap gates. */
export const PARITY_FLOORS = [
	{ label: "house_number", floor: 0.97, tags: ["house_number"] },
	{ label: "postcode", floor: 0.97, tags: ["postcode"] },
	{ label: "street", floor: 0.9, tags: ["street_prefix", "street", "street_prefix_particle", "street_suffix"] },
] as const

export interface ParityEvalOptions {
	locale?: string
	modelPath?: string
	tokenizerPath?: string
	modelCardPath?: string
	fixturesPath?: string
	/**
	 * Grade a candidate laid out as a package-shaped weights dir
	 * (`<cacheRoot>/node_modules/@mailwoman/neural-weights-<locale>`). PREFER THIS over modelPath/tokenizerPath for
	 * candidates: the explicit-path branch feeds NO sibling channels (anchor/gazetteer/calibration) and grades a crippled
	 * model — the #718 zero-fill trap.
	 */
	weightsCacheRoot?: string
	/**
	 * Probe 0 (campaign runbook): feed the decode-time street-morphology emission bias, built from the in-repo libpostal
	 * `street_types` dictionaries (all locales). Zero-training lever.
	 */
	streetMorphology?: boolean
	/** List the first N disagreeing inputs per floor label. */
	failing?: number
}

export interface ParityEvalOutcome {
	exitCode: number
}

const fold = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim()

function loadFixtures(path: string): ParityFixture[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ParityFixture)
}

/** Run the parity-corpus eval; narrates per-label + per-country tables and a floor verdict on stdout. */
export async function runParityEval(options: ParityEvalOptions = {}): Promise<ParityEvalOutcome> {
	const fixtures = loadFixtures(options.fixturesPath ?? PARITY_FIXTURES_PATH)
	const live = fixtures.filter((fixture) => !fixture.dropped && fixture.expect)

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		modelPath: options.modelPath,
		tokenizerPath: options.tokenizerPath,
		modelCardPath: options.modelCardPath,
		cacheRoot: options.weightsCacheRoot,
	})

	let fstStreetMorphology: import("@mailwoman/resolver-wof-sqlite/fst-matcher").FSTMatcher | undefined

	if (options.streetMorphology) {
		const { buildStreetMorphologyFST } = await import("@mailwoman/resolver-wof-sqlite/street-morphology-fst-builder")
		const built = buildStreetMorphologyFST({ dictionariesDir: "core/data/libpostal/dictionaries" })
		fstStreetMorphology = built.matcher
		console.log(
			`street-morphology bias ON: ${built.locales.length} locales, ${built.variantCount} variants (${built.canonicalCount} canonical)`
		)
	}

	const tallies = new Map(PARITY_FLOORS.map((f) => [f.label, { hit: 0, total: 0, failing: [] as string[] }]))
	const byCountry = new Map<string, { cases: number; fullAgree: number }>()

	for (const fixture of live) {
		const expect = fixture.expect!
		const tuples = decodeAsTuples(await classifier.parse(fixture.input, { postcodeRepair: true, fstStreetMorphology }))
		const byTag = new Map<string, string[]>()

		for (const [tag, value] of tuples) {
			byTag.set(tag, [...(byTag.get(tag) ?? []), value])
		}

		let caseAgrees = true

		for (const { label, tags } of PARITY_FLOORS) {
			const goldValues = expect[label]

			if (!goldValues?.length) continue

			const tally = tallies.get(label)!
			tally.total++
			const actual = tags.flatMap((tag) => byTag.get(tag) ?? []).join(" ")

			if (fold(actual) === fold(goldValues.join(" "))) {
				tally.hit++
			} else {
				caseAgrees = false
				tally.failing.push(
					`${fixture.id} ${JSON.stringify(fixture.input)} gold=${JSON.stringify(goldValues)} got=${JSON.stringify(actual)}`
				)
			}
		}

		// Full-case agreement (informational, never a gate): every gold tag matches. Non-floor tags
		// compare directly by tag name.
		for (const [tag, goldValues] of Object.entries(expect)) {
			if (PARITY_FLOORS.some((f) => f.label === tag)) continue

			if (fold((byTag.get(tag) ?? []).join(" ")) !== fold(goldValues.join(" "))) caseAgrees = false
		}

		const country = byCountry.get(fixture.country) ?? { cases: 0, fullAgree: 0 }
		country.cases++

		if (caseAgrees) country.fullAgree++
		byCountry.set(fixture.country, country)
	}

	console.log(`parity corpus: ${live.length} live fixtures (${fixtures.length - live.length} tombstones skipped)`)
	console.log("")
	console.log("label          agree      rate    floor  verdict")

	let pass = true

	for (const { label, floor } of PARITY_FLOORS) {
		const { hit, total } = tallies.get(label)!
		const rate = total ? hit / total : 1
		const ok = rate >= floor

		if (!ok) pass = false
		console.log(
			`${label.padEnd(13)} ${`${hit}/${total}`.padStart(8)}  ${rate.toFixed(4).padStart(7)}  ${floor.toFixed(2).padStart(5)}  ${ok ? "PASS" : "FAIL"}`
		)
	}

	console.log("")
	console.log("country  cases  full-agree")

	for (const [country, { cases, fullAgree }] of [...byCountry.entries()].sort()) {
		console.log(
			`${country.padEnd(7)} ${String(cases).padStart(6)}  ${String(fullAgree).padStart(4)} (${((fullAgree / cases) * 100).toFixed(0)}%)`
		)
	}

	const failing = options.failing ?? 0

	if (failing > 0) {
		for (const { label } of PARITY_FLOORS) {
			const list = tallies.get(label)!.failing.slice(0, failing)

			if (list.length === 0) continue
			console.log("")
			console.log(`first ${list.length} disagreements — ${label}:`)

			for (const line of list) {
				console.log(`  ${line}`)
			}
		}
	}

	console.log("")
	console.log(pass ? "✓ parity floors hold" : "✗ parity floors NOT met — campaign target")

	return { exitCode: pass ? 0 : 1 }
}

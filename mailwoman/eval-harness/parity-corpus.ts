/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The parity-corpus eval (#1093) — the rescued v1 hand-written gold scored against a checkpoint,
 *   parse-only. The ratified default gate is the triaged corpus (321 live across 20 countries; see
 *   PARITY_FIXTURES_PATH below); pass `--fixtures` for the 354-live pre-triage v1 denominator. This
 *   is the model campaign's gate for the
 *   HELD plan-2 swaps: the per-label floors below are the SAME pre-registered floors the swap gates
 *   carry (house_number ≥ 0.97, postcode ≥ 0.97, street-family ≥ 0.90 — never edited to green; a
 *   miss is an adjudication). Comparison is case-folded, whitespace-collapsed; the street label
 *   compares the assembled neural street-name family against the gold `street` values.
 */

import { readFileSync } from "node:fs"

import { decodeAsTuples } from "@mailwoman/core/decoder"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"

import type { ParityFixture } from "../dev-tools/convert-parity-fixtures.run.ts"

/**
 * Default gate corpus. RATIFIED 2026-07-13 to the triaged set (321 live / 55 tombstones): the 22 rules-era no-solution
 * assertions plus 33 gold-triage tombstones (rules-idiosyncratic fixtures a neural parser should not be graded against
 * — solver-permutation probes, autocomplete-era jitter, self-admitted TODOs; each carries a `dropped` reason). Proposal
 * + per-fixture rationale: `docs/articles/evals/competitive-parity/2026-07-13-parity-gold-triage.md`. The pre-#875 v1
 * corpus stays reproducible via `--fixtures mailwoman/eval-harness/fixtures/parity-corpus.jsonl`; the run always prints
 * which corpus + how many tombstones it skipped, so the denominator is never silent.
 */
export const PARITY_FIXTURES_PATH = "mailwoman/eval-harness/fixtures/parity-corpus.triaged.jsonl"

/** The pre-triage v1 corpus — kept for reproducing the original denominator via `--fixtures`. */
export const PARITY_FIXTURES_V1_PATH = "mailwoman/eval-harness/fixtures/parity-corpus.jsonl"

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
	/**
	 * Ship-config word-consistency heal (default true since the 2026-07-15 gate revision — production parses heal, so the
	 * gate grades the healed parse). Pass `false` to reproduce pre-heal baselines.
	 */
	wordConsistency?: boolean
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
		// Ship-config parse (gate-revision 2026-07-15): production's safeClassify/parseForGeocode heal
		// with WORD_CONSISTENCY_SHIP_DEFAULT, so the gate must grade the same parse the swapped
		// surfaces serve. Floors unchanged. Pre-heal continuity: `--no-word-consistency`.
		const tuples = decodeAsTuples(
			await classifier.parse(fixture.input, {
				postcodeRepair: true,
				fstStreetMorphology,
				enforceWordConsistency: options.wordConsistency === false ? false : WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)
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

			if (fold((byTag.get(tag) ?? []).join(" ")) !== fold(goldValues.join(" "))) {
				caseAgrees = false
			}
		}

		const country = byCountry.get(fixture.country) ?? { cases: 0, fullAgree: 0 }
		country.cases++

		if (caseAgrees) {
			country.fullAgree++
		}
		byCountry.set(fixture.country, country)
	}

	const corpusName = (options.fixturesPath ?? PARITY_FIXTURES_PATH).split("/").pop()
	console.log(
		`parity corpus: ${corpusName} — ${live.length} live fixtures (${fixtures.length - live.length} tombstones skipped)`
	)
	console.log("")
	console.log("label          agree      rate    floor  verdict")

	let pass = true

	for (const { label, floor } of PARITY_FLOORS) {
		const { hit, total } = tallies.get(label)!
		const rate = total ? hit / total : 1
		const ok = rate >= floor

		if (!ok) {
			pass = false
		}
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

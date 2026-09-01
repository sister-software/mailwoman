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

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import { computeQueryShape } from "@mailwoman/query-shape"
import type { FSTMatcher } from "@mailwoman/resolver-wof-sqlite/fst"
import { JSONSpliterator } from "spliterator"

/**
 * Default gate corpus. RATIFIED 2026-07-13 to the triaged set (321 live / 55 tombstones): the 22 rules-era no-solution
 * assertions plus 33 gold-triage tombstones (rules-idiosyncratic fixtures a neural parser should not be graded against
 * — solver-permutation probes, autocomplete-era jitter, self-admitted TODOs; each carries a `dropped` reason). Proposal
 * + per-fixture rationale: `docs/articles/evals/competitive-parity/2026-07-13-parity-gold-triage.md`. The pre-#875 v1
 * corpus stays reproducible via `--fixtures mailwoman/eval-harness/fixtures/parity-corpus.jsonl`; the run always prints
 * which corpus + how many tombstones it skipped, so the denominator is never silent.
 */
/**
 * Examples a parity bucket needs before its rate is stable enough to compare across versions.
 */
const MIN_BUCKET_EXAMPLES = 8

/**
 * Parity corpus — the cases rescued from the legacy golden set, used to compare versions.
 */
export const PARITY_FIXTURES_PATH = "packages/mailwoman/lib/eval-harness/fixtures/parity-corpus.triaged.jsonl"

/**
 * The pre-triage v1 corpus — kept for reproducing the original denominator via `--fixtures`.
 */
export const PARITY_FIXTURES_V1_PATH = "packages/mailwoman/lib/eval-harness/fixtures/parity-corpus.jsonl"

export interface ParityFixture {
	/**
	 * Stable id: `v1-<basename>-<index-within-file>`.
	 */
	id: string
	input: string
	country: string
	/**
	 * Provenance: the v1 parity file this assertion came from.
	 */
	source: string
	/**
	 * ComponentTag-keyed gold (top rules solution's hand-written expectation). Absent on tombstones.
	 */
	expect?: Record<string, string[]>
	/**
	 * Tombstone reason; the runner skips these rows but the provenance survives.
	 */
	dropped?: string
	/**
	 * Count of positional alternative records the v1 assertion carried beyond the gold.
	 */
	alternatives?: number
	/**
	 * Legacy tags in the gold that have no ComponentTag equivalent — dropped from `expect`, recorded here.
	 */
	droppedTags?: string[]
}

/**
 * Pre-registered floors (plan 2, 2026-07-13). Shared verbatim with the held swap gates.
 */
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
	 * Feed the gazetteer FST emission prior (#1497).
	 *
	 * Present because until it was, this eval could not SEE the lever: #1497's title is "FST decoder bias is invisible to
	 * every live eval", and the gauntlet was the only exception. A default-on decision needs tier-1 per-tag evidence, and
	 * that is what this corpus carries.
	 */
	gazetteerPrior?: boolean
	/**
	 * Ship-config word-consistency heal (default true since the 2026-07-15 gate revision — production parses heal, so the
	 * gate grades the healed parse). Pass `false` to reproduce pre-heal baselines.
	 */
	wordConsistency?: boolean
	/**
	 * List the first N disagreeing inputs per floor label.
	 */
	failing?: number
}

export interface ParityEvalOutcome {
	exitCode: number
}

function loadFixtures(path: string): Promise<ParityFixture[]> {
	return Array.fromAsync(JSONSpliterator.fromAsync<ParityFixture>(path))
}

/**
 * Run the parity-corpus eval; narrates per-label + per-country tables and a floor verdict on stdout.
 */
export async function runParityEval(options: ParityEvalOptions = {}): Promise<ParityEvalOutcome> {
	const fixtures = await loadFixtures(options.fixturesPath ?? PARITY_FIXTURES_PATH)
	const live = fixtures.filter((fixture) => !fixture.dropped && fixture.expect)

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		modelPath: options.modelPath,
		tokenizerPath: options.tokenizerPath,
		modelCardPath: options.modelCardPath,
		cacheRoot: options.weightsCacheRoot,
	})

	let fstGazetteer: FSTMatcher | undefined

	if (options.gazetteerPrior !== false) {
		// The classifier's OWN weights-package sibling — the same artifact the runtime loads, so this grades the prior
		// production would use rather than one resolved by a second ladder.
		const fstPath = (classifier as { fstPath?: string }).fstPath

		if (fstPath) {
			const { deserializeFST } = await import("@mailwoman/resolver-wof-sqlite/fst")

			fstGazetteer = deserializeFST(await readLocalBuffer(fstPath))

			console.log(`gazetteer prior ON (${fstPath})`)
		} else {
			// Loud, not silent. A requested prior that resolves nothing scores lower with no signal of its own, which
			// reads as a model difference — #1516's shape, and the reason five overlays needed #1705.
			console.warn(
				"gazetteer prior REQUESTED but this weights package ships no FST — the channel is OFF and these numbers " +
					"are the base model's. Do not compare them against a prior-on arm."
			)
		}
	}

	let fstStreetMorphology: FSTMatcher | undefined

	if (options.streetMorphology) {
		// Sealed-artifact-first (static-index candidate 1): the loader's shared ladder — data-root
		// `fst-street-morphology.bin`, degrading to the per-process dictionary build this site used to
		// inline (with a cwd-relative dictionaries path, no less).
		const { loadStreetMorphologyFST } = await import("@mailwoman/resolver-wof-sqlite/street")
		const loaded = await loadStreetMorphologyFST({ onWarn: (message) => console.warn(message) })
		fstStreetMorphology = loaded.matcher

		console.log(
			`street-morphology bias ON (${loaded.source === "artifact" ? `sealed artifact ${loaded.path}` : "per-process dictionary build"}${loaded.provenance ? `: ${loaded.provenance.placeCount} canonical affixes, ${loaded.provenance.nameInsertions} variant insertions` : ""})`
		)
	}

	const tallies = new Map(PARITY_FLOORS.map((f) => [f.label, { hit: 0, total: 0, failing: [] as string[] }]))
	// PRECISION — the half the floors above CANNOT see. Every floor does `if (!goldValues?.length)
	// continue`, so a tag emitted where the gold has NONE costs nothing, forever. That is the same
	// blind spot T1a found on street (the board flattered the span decode because its failure lived
	// in the rows the filter dropped) and the deepparse comparison found on postcode: we report
	// postcode 98.6% and that is RECALL — on 249 rows with no gold postcode, v264 emits one on 25.
	// 16 of those are a house_number read as a postcode ("Epleskogen 39A" -> postcode "39A"), and
	// `39A` is not a postcode in any system. Informational, not a floor: a floor is the operator's.
	const precision = new Map(PARITY_FLOORS.map((f) => [f.label, { spurious: 0, absent: 0, examples: [] as string[] }]))
	const byCountry = new Map<string, { cases: number; fullAgree: number }>()

	for (const fixture of live) {
		const expect = fixture.expect!

		// Ship-config parse (gate-revision 2026-07-15): production's safeClassify/parseForGeocode heal
		// with WORD_CONSISTENCY_SHIP_DEFAULT, so the gate must grade the same parse the swapped
		// surfaces serve. Floors unchanged. Pre-heal continuity: `--no-word-consistency`.
		// Production config parity (#1146): the query-shape emission prior is fed on EVERY path
		// production parses on — `safeClassify` in the runtime pipeline, and `geocode-core` since #981
		// (which fixed this same divergence for the drop-in servers). Without it this gate graded a
		// starved parse. A no-op on inputs carrying no known format and no region abbrev, so the bare
		// `street, city` class is byte-stable; it earns its keep on the digit-span / region-abbrev rows.
		const byTag = groupTuplesByTag(
			await classifier.parse(fixture.input, {
				postcodeRepair: true,
				queryShape: computeQueryShape(fixture.input),
				fstStreetMorphology,
				...(fstGazetteer ? { fst: fstGazetteer } : {}),
				enforceWordConsistency: options.wordConsistency === false ? false : WORD_CONSISTENCY_SHIP_DEFAULT,
			})
		)

		let caseAgrees = true

		// The precision half: on a row whose gold does NOT carry this tag, did we emit it anyway?
		for (const { label, tags } of PARITY_FLOORS) {
			if (expect[label]?.length) continue
			const bucket = precision.get(label)!

			bucket.absent++
			const emitted = tags.flatMap((tag) => byTag.get(tag) ?? []).join(" ")

			if (emitted) {
				bucket.spurious++

				if (bucket.examples.length < MIN_BUCKET_EXAMPLES) {
					bucket.examples.push(`${JSON.stringify(fixture.input)} -> ${label}=${JSON.stringify(emitted)}`)
				}
			}
		}

		for (const { label, tags } of PARITY_FLOORS) {
			const goldValues = expect[label]

			if (!goldValues?.length) continue

			const tally = tallies.get(label)!

			tally.total++
			const actual = tags.flatMap((tag) => byTag.get(tag) ?? []).join(" ")

			if (foldCaseWhitespace(actual) === foldCaseWhitespace(goldValues.join(" "))) {
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

			if (foldCaseWhitespace((byTag.get(tag) ?? []).join(" ")) !== foldCaseWhitespace(goldValues.join(" "))) {
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

	// The precision half. INFORMATIONAL, never a verdict — a floor here is an operator act. Reported
	// because "postcode 98.6%" is a recall number and reads like a capability, and the missing half is
	// where the house_number deficit went.
	console.log("")
	console.log("precision (the half the floors above cannot see — rows whose gold has NO such tag)")
	console.log("label          spurious   rate     of rows")

	for (const { label } of PARITY_FLOORS) {
		const { spurious, absent } = precision.get(label)!

		if (!absent) continue

		console.log(
			`${label.padEnd(13)} ${`${spurious}/${absent}`.padStart(8)}  ${(spurious / absent).toFixed(4).padStart(7)}   emitted where gold has none`
		)
	}

	for (const { label } of PARITY_FLOORS) {
		const { examples } = precision.get(label)!

		if (!examples.length) continue

		console.log(`\n  --- ${label}: emitted where the gold has none (first ${examples.length}) ---`)

		for (const example of examples) {
			console.log(`    ${example}`)
		}
	}

	console.log("")
	console.log("country  cases  full-agree")

	for (const [country, { cases, fullAgree }] of [...byCountry.entries()].toSorted()) {
		console.log(
			`${country.padEnd(7)} ${String(cases).padStart(6)}  ${String(fullAgree).padStart(4)} (${((fullAgree / cases) * 100).toFixed(0)}%)`
		)
	}

	const failing = options.failing ?? 0

	if (failing > 0) {
		for (const { label } of PARITY_FLOORS) {
			const list = tallies.get(label)!.failing.slice(0, failing)

			if (!list.length) continue

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

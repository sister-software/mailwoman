/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Score parser output against the hand-written parity corpus.
 *   Default floors are pre-registered; comparisons fold case and whitespace.
 *   The street floor covers the assembled neural street-name family.
 */

import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import { computeQueryShape } from "@mailwoman/query-shape"
import type { FSTMatcher } from "@mailwoman/resolver-wof-sqlite/fst"
import type { PathBuilderLike } from "path-ts"
import { JSONSpliterator } from "spliterator"

/**
 * Default triaged corpus; pass `--fixtures` to reproduce the original v1 denominator.
 * The report names the corpus and counts skipped tombstones.
 */
/**
 * Minimum examples retained for parity-bucket diagnostics.
 */
const MIN_BUCKET_EXAMPLES = 8

/**
 * Default triaged parity corpus.
 */
export const PARITY_FIXTURES_PATH = "packages/mailwoman/lib/eval-harness/fixtures/parity-corpus.triaged.jsonl"

/**
 * Original v1 corpus, available through `--fixtures`.
 */
export const PARITY_FIXTURES_V1_PATH = "packages/mailwoman/lib/eval-harness/fixtures/parity-corpus.jsonl"

export interface ParityFixture {
	/**
	 * Stable source-derived fixture id.
	 */
	id: string
	input: string
	country: string
	/**
	 * Provenance: the v1 parity file this assertion came from.
	 */
	source: string
	/**
	 * Expected component values; absent on tombstones.
	 */
	expect?: Record<string, string[]>
	/**
	 * Tombstone reason.
	 * The runner skips these rows but the provenance survives.
	 */
	dropped?: string
	/**
	 * Number of positional alternatives in the original assertion.
	 */
	alternatives?: number
	/**
	 * Legacy tags without a `ComponentTag` equivalent.
	 */
	droppedTags?: string[]
}

/**
 * Pre-registered floors (plan 2, 2026-07-13).
 *
 * Shared verbatim with the held swap checks.
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
	 * Package-shaped candidate weights root, including sibling channels.
	 */
	weightsCacheRoot?: string
	/**
	 * Enable the decode-time street-morphology emission bias.
	 */
	streetMorphology?: boolean
	/**
	 * Enable the gazetteer FST emission prior.
	 */
	gazetteerPrior?: boolean
	/**
	 * Use production word-consistency healing; disable to reproduce older baselines.
	 */
	wordConsistency?: boolean
	/**
	 * Maximum disagreements listed per floor label.
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
 * Run the parity-corpus eval.
 *
 * Narrates per-label + per-country tables and a floor verdict on stdout.
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
		// Use the classifier's weights-package sibling, matching runtime resolution.
		const fstPath = (classifier as { fstPath?: PathBuilderLike }).fstPath

		if (fstPath) {
			const { deserializeFST } = await import("@mailwoman/resolver-wof-sqlite/fst")

			fstGazetteer = deserializeFST(await readLocalBuffer(fstPath))

			console.log(`gazetteer prior ON (${fstPath})`)
		} else {
			// Report missing FST explicitly; otherwise results could be misread as prior-on.
			console.warn(
				"gazetteer prior REQUESTED but this weights package ships no FST — the channel is OFF and these numbers " +
					"are the base model's. Do not compare them against a prior-on arm."
			)
		}
	}

	let fstStreetMorphology: FSTMatcher | undefined

	if (options.streetMorphology) {
		// Use the shared loader's artifact-first resolution and fallback behavior.
		const { loadStreetMorphologyFST } = await import("@mailwoman/resolver-wof-sqlite/street")
		const loaded = await loadStreetMorphologyFST({ onWarn: (message) => console.warn(message) })
		fstStreetMorphology = loaded.matcher

		console.log(
			`street-morphology bias ON (${loaded.source === "artifact" ? `sealed artifact ${loaded.path}` : "per-process dictionary build"}${loaded.provenance ? `: ${loaded.provenance.placeCount} canonical affixes, ${loaded.provenance.nameInsertions} variant insertions` : ""})`
		)
	}

	const tallies = new Map(PARITY_FLOORS.map((f) => [f.label, { hit: 0, total: 0, failing: [] as string[] }]))
	// Measure precision separately: floor rates exclude rows whose gold lacks the tag.
	// Informational only; operators set any precision floor.
	const precision = new Map(PARITY_FLOORS.map((f) => [f.label, { spurious: 0, absent: 0, examples: [] as string[] }]))
	const byCountry = new Map<string, { cases: number; fullAgree: number }>()

	for (const fixture of live) {
		const expect = fixture.expect!

		// Match production parse options, including query shape and word consistency.
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

		// The precision half: on a row whose gold does not carry this tag, did we emit it anyway?
		for (const { label, tags } of PARITY_FLOORS) {
			if (expect[label]?.length) continue
			const bucket = precision.get(label)!

			bucket.absent++
			const emitted = tags.flatMap((tag) => byTag.get(tag) ?? []).join(" ")

			if (emitted) {
				bucket.spurious++

				if (bucket.examples.length < MIN_BUCKET_EXAMPLES) {
					bucket.examples.push(`${stringifyJSON(fixture.input)} -> ${label}=${stringifyJSON(emitted)}`)
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
					`${fixture.id} ${stringifyJSON(fixture.input)} gold=${stringifyJSON(goldValues)} got=${stringifyJSON(actual)}`
				)
			}
		}

		// Report full-case agreement separately; non-floor tags compare by tag name.
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

	// Precision is informational and does not affect the verdict.
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

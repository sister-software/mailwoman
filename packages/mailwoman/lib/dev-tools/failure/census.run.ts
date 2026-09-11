/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Failure census: every parity disagreement on a candidate (grade-cache), bucketed by mechanism.
 *   Run from the repo root: `node packages/mailwoman/lib/dev-tools/failure/census.run.ts`
 */
import { groupTuplesByTag } from "@mailwoman/core/decoder"
import { STREET_FAMILY_TAGS } from "@mailwoman/core/types"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import { JSONSpliterator } from "spliterator"

import { PARITY_FIXTURES_V1_PATH, type ParityFixture } from "#eval-harness/parity-corpus"

/**
 * Samples a failure class needs before it is listed rather than folded into the tail.
 */
const MIN_REPORTABLE_SAMPLES = 3

/**
 * Missing components tolerated before a parse counts as a prefix match rather than a truncation.
 */
const MAX_MISSING_TAIL_COMPONENTS = 3

const SCRATCH = "/tmp/claude-1000/-home-lab-Projects-mailwoman/68bebf18-8fe3-4263-ae64-70c79a08f97c/scratchpad"

const fixtures: ParityFixture[] = (
	await Array.fromAsync(JSONSpliterator.fromAsync<ParityFixture>(PARITY_FIXTURES_V1_PATH))
).filter((f) => !f.dropped && f.expect)

const classifier = await NeuralAddressClassifier.loadFromWeights({
	locale: "en-US",
	cacheRoot: `${SCRATCH}/v251-grade-cache`,
})

type Bucket = string
const buckets = new Map<Bucket, { count: number; samples: string[] }>()
const hnBuckets = new Map<Bucket, { count: number; samples: string[] }>()

function put(map: Map<Bucket, { count: number; samples: string[] }>, bucket: Bucket, sample: string) {
	const entry = map.get(bucket) ?? { count: 0, samples: [] }

	entry.count++

	if (entry.samples.length < MIN_REPORTABLE_SAMPLES) {
		entry.samples.push(sample)
	}

	map.set(bucket, entry)
}

/**
 * Does `got` equal `gold` with 1-2 chars DELETED mid-string (the mangle signature)?
 */
function looksMangled(gold: string, got: string): boolean {
	if (!got.length || got.length >= gold.length) return false
	// subsequence with small deletion count
	let i = 0

	for (const ch of gold) {
		if (i < got.length && got[i] === ch) {
			i++
		}
	}

	return i === got.length && gold.length - got.length <= MAX_MISSING_TAIL_COMPONENTS
}

for (const fixture of fixtures) {
	const byTag = groupTuplesByTag(await classifier.parse(fixture.input, { postcodeRepair: true }))

	// STREET
	const goldStreet = fixture.expect!.street

	if (goldStreet?.length) {
		const gold = foldCaseWhitespace(goldStreet.join(" "))
		const got = foldCaseWhitespace(STREET_FAMILY_TAGS.flatMap((t) => byTag.get(t) ?? []).join(" "))

		if (got !== gold) {
			const sample = `[${fixture.country}] ${JSON.stringify(fixture.input)} gold=${JSON.stringify(gold)} got=${JSON.stringify(got)}`
			const goldHasDiacritic = /\P{ASCII}/u.test(gold)

			if (got === "") {
				put(buckets, goldHasDiacritic ? "empty (diacritic gold)" : "empty (ascii gold)", sample)
			} else if (got.startsWith(gold) && /\d/.test(got.slice(gold.length))) {
				put(buckets, "boundary: absorbs trailing digits", sample)
			} else if (got.startsWith(gold)) {
				put(buckets, "boundary: absorbs trailing words (over-grab)", sample)
			} else if (gold.startsWith(got) || gold.endsWith(got)) {
				put(buckets, "partial: under-grab / truncation", sample)
			} else if (
				looksMangled(gold, got) ||
				(goldHasDiacritic && got.replaceAll(/\s/g, "").length < gold.replaceAll(/\s/g, "").length)
			) {
				put(buckets, "mangle: chars lost mid-span", sample)
			} else {
				put(buckets, "other / re-segmented", sample)
			}
		}
	}

	// HOUSE NUMBER
	const goldHn = fixture.expect!.house_number

	if (goldHn?.length) {
		const gold = foldCaseWhitespace(goldHn.join(" "))
		const got = foldCaseWhitespace((byTag.get("house_number") ?? []).join(" "))

		if (got !== gold) {
			const sample = `[${fixture.country}] ${JSON.stringify(fixture.input)} gold=${JSON.stringify(gold)} got=${JSON.stringify(got)}`

			if (got === "") {
				put(hnBuckets, "empty (number went elsewhere)", sample)
			} else if (gold.includes("/") || /^(u|unit|lot|apt|flat)/i.test(fixture.input)) {
				put(hnBuckets, "compact unit/lot form", sample)
			} else if (got.length < gold.length && gold.endsWith(got)) {
				put(hnBuckets, "offset bleed (prefix chars lost)", sample)
			} else if (got.length < gold.length) {
				put(hnBuckets, "partial number", sample)
			} else {
				put(hnBuckets, "other", sample)
			}
		}
	}
}

console.log("=== STREET failure census (of 300 gold slots) ===")

for (const [bucket, { count, samples }] of [...buckets.entries()].toSorted((a, b) => b[1].count - a[1].count)) {
	console.log(`\n${bucket}: ${count}`)

	for (const s of samples) {
		console.log(`   ${s}`)
	}
}

console.log("\n=== HOUSE_NUMBER failure census (of 154 gold slots) ===")

for (const [bucket, { count, samples }] of [...hnBuckets.entries()].toSorted((a, b) => b[1].count - a[1].count)) {
	console.log(`\n${bucket}: ${count}`)

	for (const s of samples) {
		console.log(`   ${s}`)
	}
}

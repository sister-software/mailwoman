/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does the MODEL refuse the locality, or does a decode-time prior take it away? (#2311)
 *
 *   `traceParse` carries both readings of the same token: `logits` is the model's raw emission, and `emissions` is what
 *   viterbi decoded over, after every prior in `priors` has written into it. A row whose raw emission already refuses
 *   the locality is a training result. A row whose raw emission favours it and whose post-prior matrix does not names
 *   the prior that took it.
 *
 *   The margin is `max(locality labels) - max(every label)` at the pieces covering the expected locality, so `0` means
 *   a locality label won and a negative number is how far behind it came. A margin says how far the locality came
 *   behind; the winning label beside it says what it came behind, which is the difference between a model that is
 *   unsure and one that has learned another reading.
 *
 *   `--swap-region` and `--swap-postcode` re-render each subject under a different region code or postcode, so the
 *   crossed 2x2 can be read at the logit level, before any decision threshold. A crossed pairing denotes no place and
 *   nothing here claims one.
 *
 *   `--by` chooses what the rows are grouped into, which is what lets #2308's word effect and #2311's region effect be
 *   read in the same units on the same panel. `region-suffix` is the crossed one: within each region, the rows whose
 *   locality ends in a USPS suffix word beside the rows that do not. Two effects reported as pass rates cannot be
 *   compared; two margins in logits can be added.
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --weights-cache <dir>
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --regions AR --swap-postcode 05842
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --by region-suffix --per-group 20
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"

import { readCoordPanel, renderAdmin, suffixTail } from "#dev-tools/coord-panel"
import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"weights-cache": { type: "string" },
		eval: { type: "string", default: String(dataRootPath("eval", "coord", "us-stratified.jsonl")) },
		/**
		 * Regions to read, comma-separated. Every region in the panel when absent.
		 */
		regions: { type: "string" },
		/**
		 * What the rows are grouped into: `region`, `tail` (the locality's USPS-suffix last word), `suffix` (whether it has
		 * one at all), or `region-suffix` (both, which is the crossed read).
		 */
		by: { type: "string", default: "region" },
		/**
		 * Rows to read per group. `--per-region` is the older spelling of the same cap and still works.
		 */
		"per-group": { type: "string" },
		"per-region": { type: "string", default: "40" },
		country: { type: "string", default: "US" },
		/**
		 * Re-render each subject's region as this code, leaving its locality and postcode alone.
		 */
		"swap-region": { type: "string" },
		/**
		 * Re-render each subject's postcode as this literal, leaving its locality and region alone.
		 */
		"swap-postcode": { type: "string" },
	},
})

const { localities } = await readCoordPanel(values.eval!, { country: values.country })
const asked = values.regions?.split(",").map((code) => code.trim().toUpperCase())
const perGroup = Number(values["per-group"] ?? values["per-region"])

/**
 * The grouping axes, each a function from a panel place to the group it counts in.
 *
 * `suffix` is the boolean form of `tail`, and both name the word by its own spelling rather than "yes"/"no": a table
 * row reading `-park` says which word carried it, and one reading `(plain)` says the locality ends in no suffix word at
 * all. The `-` prefix keeps the two apart when `region-suffix` joins them.
 */
const GROUPERS = {
	region: (place: (typeof localities)[number]) => place.region,
	tail: (place: (typeof localities)[number]) => {
		const tail = suffixTail(place.locality)

		return tail ? `-${tail}` : "(plain)"
	},
	suffix: (place: (typeof localities)[number]) => (suffixTail(place.locality) ? "suffix tail" : "(plain)"),
	"region-suffix": (place: (typeof localities)[number]) =>
		`${place.region} ${suffixTail(place.locality) ? "suffix tail" : "(plain)"}`,
} as const

type GroupAxis = keyof typeof GROUPERS

if (!Object.hasOwn(GROUPERS, values.by!)) {
	throw new Error(`--by ${values.by} is not one of: ${Object.keys(GROUPERS).join(", ")}`)
}

const groupOf = GROUPERS[values.by as GroupAxis]
const byGroup = new Map<string, typeof localities>()

for (const place of localities) {
	if (asked && !asked.includes(place.region)) continue

	const key = groupOf(place)
	const bucket = byGroup.get(key)

	if (bucket && bucket.length < perGroup) {
		bucket.push(place)
	} else if (!bucket) {
		byGroup.set(key, [place])
	}
}

if (!byGroup.size) {
	throw new Error(
		`${values.eval} holds none of the regions asked for. It carries: ` +
			`${[...new Set(localities.map((place) => place.region))].toSorted().join(", ")}.`
	)
}

const deps = await buildGauntletDeps(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {})

/**
 * A BIO label names its tag after the prefix, so both `B-locality` and `I-locality` count as the locality reading.
 */
function isLocalityLabel(label: string): boolean {
	return label.endsWith("-locality") || label === "locality"
}

/**
 * The margin of the locality reading at one token: the best locality label's score minus the best score of any label.
 * Zero when a locality label already wins; negative by how far it lost.
 */
function localityMargin(row: readonly number[], labels: readonly string[]): number {
	let best = Number.NEGATIVE_INFINITY
	let bestLocality = Number.NEGATIVE_INFINITY

	for (const [index, score] of row.entries()) {
		if (score > best) {
			best = score
		}

		if (isLocalityLabel(labels[index] ?? "") && score > bestLocality) {
			bestLocality = score
		}
	}

	return bestLocality === Number.NEGATIVE_INFINITY ? Number.NEGATIVE_INFINITY : bestLocality - best
}

interface GroupMargins {
	rows: number
	decodedAsLocality: number
	rawMargin: number
	decodedMargin: number
	priorsApplied: Map<string, number>
	/**
	 * What won at the first locality piece instead. A margin says how far the locality came behind; this says what it
	 * came behind, which is the difference between a model that is unsure and one that has learned another reading.
	 */
	decodedAs: Map<string, number>
	unlocated: number
}

const results = new Map<string, GroupMargins>()

for (const [group, bucket] of [...byGroup].toSorted()) {
	const entry: GroupMargins = {
		rows: 0,
		decodedAsLocality: 0,
		rawMargin: 0,
		decodedMargin: 0,
		priorsApplied: new Map(),
		decodedAs: new Map(),
		unlocated: 0,
	}

	for (const subject of bucket) {
		// A crossed pairing denotes no place, and nothing here claims one: the grade is the locality label's margin at
		// the tokens the locality occupies, which is a reading of what the decode conditions on.
		const place = {
			...subject,
			region: values["swap-region"] ?? subject.region,
			postcode: values["swap-postcode"] ?? subject.postcode,
		}

		const input = renderAdmin(place)
		// `caseCountry`, not `defaultCountry`: the first selects the weights overlay the classifier loads with, which is
		// what a trace is about; the second is a resolver prior `diagnoseParse` never reaches.
		const { trace } = await deps.diagnoseParse(input, { caseCountry: place.country })
		const start = input.indexOf(place.locality)

		// A layout that rewrites the locality (transliteration, a different casing) leaves nothing to index against, and
		// a margin read at the wrong tokens is a number about the wrong part of the string.
		if (start === -1) {
			entry.unlocated++

			continue
		}

		const end = start + place.locality.length

		const covering = trace.pieces
			.map((piece, index) => ({ piece, index }))
			.filter(({ piece }) => piece.start < end && piece.end > start)

		if (!covering.length) {
			entry.unlocated++

			continue
		}

		entry.rows++

		const first = covering[0]!

		const won = trace.labels[trace.path[first.index]!] ?? "?"

		entry.decodedAs.set(won, (entry.decodedAs.get(won) ?? 0) + 1)

		if (isLocalityLabel(won)) {
			entry.decodedAsLocality++
		}

		let raw = 0
		let decoded = 0

		for (const { index } of covering) {
			raw += localityMargin(trace.logits[index] ?? [], trace.labels)
			decoded += localityMargin(trace.emissions[index] ?? [], trace.labels)
		}

		entry.rawMargin += raw / covering.length
		entry.decodedMargin += decoded / covering.length

		for (const prior of trace.priors) {
			if (prior.applied) {
				entry.priorsApplied.set(prior.kind, (entry.priorsApplied.get(prior.kind) ?? 0) + 1)
			}
		}
	}

	results.set(group, entry)
}

const swaps: string[] = []

if (values["swap-region"]) {
	swaps.push(`region → ${values["swap-region"]}`)
}

if (values["swap-postcode"]) {
	swaps.push(`postcode → ${values["swap-postcode"]}`)
}

const swapped = swaps.join(", ")

console.log(
	`#2311 decode margins — ${values.eval}, by ${values.by}, ${results.size} group(s)${swapped ? `, ${swapped}` : ""}\n`
)
console.log(`| ${values.by} | rows | decoded as locality | raw margin | post-prior margin | what won instead |`)
console.log(`| --- | --: | --: | --: | --: | --- |`)

for (const [group, entry] of [...results].toSorted(
	(a, b) => b[1].decodedAsLocality / b[1].rows - a[1].decodedAsLocality / a[1].rows
)) {
	const won = [...entry.decodedAs]
		.filter(([label]) => !isLocalityLabel(label))
		.toSorted((a, b) => b[1] - a[1])
		.map(([label, n]) => `${label} ${n}`)
		.join(", ")

	console.log(
		`| ${group} | ${entry.rows} | ${formatPercent(entry.decodedAsLocality, entry.rows)} ` +
			`| ${(entry.rawMargin / entry.rows).toFixed(3)} | ${(entry.decodedMargin / entry.rows).toFixed(3)} ` +
			`| ${won || "—"} |`
	)
}

const unlocated = [...results.values()].reduce((sum, entry) => sum + entry.unlocated, 0)

if (unlocated) {
	console.log(`\n${unlocated} row(s) skipped: the rendered address does not carry the expected locality verbatim`)
}

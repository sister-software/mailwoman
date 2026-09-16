/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does the MODEL refuse the locality, or does a decode-time prior take it away? (#2311)
 *
 *   The bare admin surface reads 100.0% in Vermont and 2.3% in Arkansas, and eight properties of the training corpus
 *   fail to predict which region a row falls in — six of them with the sign backwards. That exhausts the corpus as an
 *   explanation and leaves the decode, which has two halves a rate cannot tell apart.
 *
 *   `traceParse` carries both: `logits` is the model's raw emission and `emissions` is what viterbi decoded over, after
 *   every prior in `priors` has written into it. So the locality label's margin can be read twice for the same token.
 *   A row where the raw emission already refuses the locality is a training result. A row where the raw emission
 *   favours it and the post-prior matrix does not names the prior that took it.
 *
 *   The margin is `max(locality labels) - max(every label)` at the pieces covering the expected locality, so `0` means
 *   a locality label won and a negative number is how far behind it came. Reported as a mean over a region's rows
 *   alongside the share of rows whose first locality piece was decoded as a locality at all.
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --weights-cache <dir>
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --regions AR,VT --per-region 40
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"

import { readCoordPanel, renderAdmin } from "#dev-tools/coord-panel"
import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"weights-cache": { type: "string" },
		eval: { type: "string", default: String(dataRootPath("eval", "coord", "us-stratified.jsonl")) },
		/**
		 * Regions to read, comma-separated. Every region in the panel when absent.
		 */
		regions: { type: "string" },
		"per-region": { type: "string", default: "40" },
		country: { type: "string", default: "US" },
	},
})

const { localities } = await readCoordPanel(values.eval!, { country: values.country })
const asked = values.regions?.split(",").map((code) => code.trim().toUpperCase())
const perRegion = Number(values["per-region"])
const byRegion = new Map<string, typeof localities>()

for (const place of localities) {
	if (asked && !asked.includes(place.region)) continue

	const bucket = byRegion.get(place.region)

	if (bucket && bucket.length < perRegion) {
		bucket.push(place)
	} else if (!bucket) {
		byRegion.set(place.region, [place])
	}
}

if (!byRegion.size) {
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

interface RegionMargins {
	rows: number
	decodedAsLocality: number
	rawMargin: number
	decodedMargin: number
	priorsApplied: Map<string, number>
	unlocated: number
}

const results = new Map<string, RegionMargins>()

for (const [region, bucket] of [...byRegion].toSorted()) {
	const entry: RegionMargins = {
		rows: 0,
		decodedAsLocality: 0,
		rawMargin: 0,
		decodedMargin: 0,
		priorsApplied: new Map(),
		unlocated: 0,
	}

	for (const place of bucket) {
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

		if (isLocalityLabel(trace.labels[trace.path[first.index]!] ?? "")) {
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

	results.set(region, entry)
}

console.log(`#2311 decode margins — ${values.eval}, ${results.size} region(s)\n`)
console.log(`| region | rows | decoded as locality | raw margin | post-prior margin | priors that fired |`)
console.log(`| --- | --: | --: | --: | --: | --- |`)

for (const [region, entry] of [...results].toSorted(
	(a, b) => b[1].decodedAsLocality / b[1].rows - a[1].decodedAsLocality / a[1].rows
)) {
	const priors = [...entry.priorsApplied]
		.toSorted((a, b) => b[1] - a[1])
		.map(([kind, n]) => `${kind} ${n}`)
		.join(", ")

	console.log(
		`| ${region} | ${entry.rows} | ${formatPercent(entry.decodedAsLocality, entry.rows)} ` +
			`| ${(entry.rawMargin / entry.rows).toFixed(3)} | ${(entry.decodedMargin / entry.rows).toFixed(3)} ` +
			`| ${priors || "none"} |`
	)
}

const unlocated = [...results.values()].reduce((sum, entry) => sum + entry.unlocated, 0)

if (unlocated) {
	console.log(`\n${unlocated} row(s) skipped: the rendered address does not carry the expected locality verbatim`)
}

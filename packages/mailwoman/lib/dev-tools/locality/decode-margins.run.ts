/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `traceParse` carries both readings of a token — `logits`, the model's raw emission, and
 *   `emissions`, what viterbi decoded over after every prior wrote into it — so a row whose raw
 *   emission already refuses the locality is a training result while one whose raw emission
 *   favours it and whose post-prior matrix does not names the prior that took it.
 */

import { matchSubdivisionIn } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { formatPercent } from "@mailwoman/core/stats"
import { TextSpliterator } from "spliterator"

import { readCoordPanel, renderAdmin, suffixTail } from "#dev-tools/coord-panel"
import { buildGauntletDeps } from "#eval-harness/gauntlet/harness"

const { values } = parseArguments({
	options: {
		"weights-cache": { type: "string" },
		eval: { type: "string", default: dataRootPath("eval", "coord", "us-stratified.jsonl").toString() },
		regions: { type: "string" },
		by: { type: "string", default: "region" },
		"per-group": { type: "string" },
		"per-region": { type: "string", default: "40" },
		country: { type: "string", default: "US" },
		"swap-region": { type: "string" },
		"swap-postcode": { type: "string" },
		/**
		 * Off by default: every row then costs both a trace and a geocode.
		 */
		"with-geocode": { type: "boolean" },
		"spell-region": { type: "boolean" },
		"drop-postcode": { type: "boolean" },
		/**
		 * The model was trained with the near-postcode choreography, so serving without
		 * it is a mismatch and never a shipping configuration.
		 */
		"no-gazetteer-suppression": { type: "boolean" },
	},
})

const { localities } = await readCoordPanel(values.eval!, { country: values.country })

const asked = values.regions
	? TextSpliterator.from(values.regions, { delimiter: "," })
			.map((code) => code.toUpperCase())
			.toArray()
	: undefined

const perGroup = Number(values["per-group"] ?? values["per-region"])

function shapeOf(locality: string): string {
	if (suffixTail(locality)) return "suffix tail"

	return locality.trim().split(/\s+/).length > 1 ? "multi-word" : "single word"
}

const GROUPERS = {
	region: (place: (typeof localities)[number]) => place.region,
	tail: (place: (typeof localities)[number]) => {
		const tail = suffixTail(place.locality)

		return tail ? `-${tail}` : "(plain)"
	},
	shape: (place: (typeof localities)[number]) => shapeOf(place.locality),
	"region-shape": (place: (typeof localities)[number]) => `${place.region} ${shapeOf(place.locality)}`,
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

const deps = await buildGauntletDeps({
	...(values["weights-cache"] ? { weightsCacheRoot: values["weights-cache"] } : {}),
	...(values["no-gazetteer-suppression"] ? { suppressGazetteerNearPostcode: false } : {}),
})

function isLocalityLabel(label: string): boolean {
	return label.endsWith("-locality") || label === "locality"
}

/**
 * The best locality label's score minus the best score of any label at one token,
 * so zero means a locality label won and a negative value is how far it lost.
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
	/**
	 * Rows whose resolved locality is the expected one, counted only under `--with-geocode`:
	 * a row can lose the locality span and still answer the right place from its region and postcode.
	 */
	answeredExpected: number
	answeredNothing: number
	rawMargin: number
	decodedMargin: number
	priorsApplied: Map<string, number>
	/**
	 * What won at the first locality piece instead: the margin says how far the
	 * locality came behind, this says what it came behind.
	 */
	decodedAs: Map<string, number>
	unlocated: number
}

const results = new Map<string, GroupMargins>()

for (const [group, bucket] of [...byGroup].toSorted()) {
	const entry: GroupMargins = {
		rows: 0,
		decodedAsLocality: 0,
		answeredExpected: 0,
		answeredNothing: 0,
		rawMargin: 0,
		decodedMargin: 0,
		priorsApplied: new Map(),
		decodedAs: new Map(),
		unlocated: 0,
	}

	for (const subject of bucket) {
		const spelled = values["spell-region"] ? matchSubdivisionIn(subject.country, subject.region)?.name : undefined

		// A region the codex cannot spell is skipped rather than rendered under its code: leaving
		// it in would put coded rows inside an arm whose whole claim is that they are spelled.
		if (values["spell-region"] && !spelled) {
			entry.unlocated++

			continue
		}

		// A crossed pairing denotes no place, so the only grade read here is the locality
		// label's margin at the tokens the locality occupies.
		const place = {
			...subject,
			region: spelled ?? values["swap-region"] ?? subject.region,
			postcode: values["drop-postcode"] ? "" : (values["swap-postcode"] ?? subject.postcode),
		}

		const input = renderAdmin(place)
		// `caseCountry`, not `defaultCountry`: the first selects the weights overlay the classifier
		// loads with, while the second is a resolver prior `diagnoseParse` never reaches.
		const { trace } = await deps.diagnoseParse(input, { caseCountry: place.country })
		const start = input.indexOf(place.locality)

		// A rewritten locality (transliteration, different casing) leaves no token to index against,
		// and a margin read at the wrong tokens describes the wrong part of the string.
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

		if (values["with-geocode"]) {
			// `defaultCountry` here rather than `caseCountry`: this call is the resolver's,
			// and the country it takes is the scope prior the answer is produced under.
			const answered = (await deps.geocode(input, { defaultCountry: place.country })).locality ?? null

			if (answered === null) {
				entry.answeredNothing++
			} else if (answered === place.locality) {
				entry.answeredExpected++
			}
		}

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

if (values["spell-region"]) {
	swaps.push("region spelled")
}

if (values["drop-postcode"]) {
	swaps.push("postcode dropped")
}

if (values["no-gazetteer-suppression"]) {
	swaps.push("near-postcode gazetteer choreography OFF")
}

if (values["swap-region"]) {
	swaps.push(`region → ${values["swap-region"]}`)
}

if (values["swap-postcode"]) {
	swaps.push(`postcode → ${values["swap-postcode"]}`)
}

const swapped = swaps.join(", ")

// Without `--weights-cache` the run grades the installed weights, which are not
// interchangeable with a candidate's, so the header names which one the table came from.
const weights = values["weights-cache"]
	? `candidate ${values["weights-cache"]}`
	: "INSTALLED weights (no --weights-cache)"

console.log(
	`#2311 decode margins — ${values.eval}, by ${values.by}, ${results.size} group(s)${swapped ? `, ${swapped}` : ""}\n` +
		`weights: ${weights}\n`
)

const answerColumns = values["with-geocode"] ? ` answered expected | answered nothing |` : ""
const answerRule = values["with-geocode"] ? ` --: | --: |` : ""

console.log(
	`| ${values.by} | rows | decoded as locality |${answerColumns} raw margin | post-prior margin | what won instead |`
)
console.log(`| --- | --: | --: |${answerRule} --: | --: | --- |`)

for (const [group, entry] of [...results].toSorted(
	(a, b) => b[1].decodedAsLocality / b[1].rows - a[1].decodedAsLocality / a[1].rows
)) {
	const won = [...entry.decodedAs]
		.filter(([label]) => !isLocalityLabel(label))
		.toSorted((a, b) => b[1] - a[1])
		.map(([label, n]) => `${label} ${n}`)
		.join(", ")

	const answers = values["with-geocode"]
		? ` ${formatPercent(entry.answeredExpected, entry.rows)} | ${entry.answeredNothing} |`
		: ""

	console.log(
		`| ${group} | ${entry.rows} | ${formatPercent(entry.decodedAsLocality, entry.rows)} |${answers}` +
			` ${(entry.rawMargin / entry.rows).toFixed(3)} | ${(entry.decodedMargin / entry.rows).toFixed(3)} ` +
			`| ${won || "—"} |`
	)
}

const unlocated = [...results.values()].reduce((sum, entry) => sum + entry.unlocated, 0)

if (unlocated) {
	console.log(`\n${unlocated} row(s) skipped: the rendered address does not carry the expected locality verbatim`)
}

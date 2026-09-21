/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does the model refuse the locality, or does a decode-time prior take it away? (#2311)
 *
 *   `traceParse` carries both readings of the same token: `logits` is the model's raw emission, and `emissions` is what
 *   viterbi decoded over, after every prior in `priors` has written into it. A row whose raw emission already refuses
 *   the locality is a training result. A row whose raw emission favours it and whose post-prior matrix does not names
 *   the prior that took it.
 *
 *   The margin is `max(locality labels) - max(every label)` at the pieces covering the expected locality, so `0` means
 *   a locality label won and a negative number is how far behind it came. A margin says how far the locality came
 *   behind. the winning label beside it says what it came behind, which is the difference between a model that is
 *   unsure and one that has learned another reading.
 *
 *   `--swap-region` and `--swap-postcode` re-render each subject under a different region code or postcode, so the
 *   crossed 2x2 can be read at the logit level, before any decision threshold. A crossed pairing denotes no place and
 *   nothing here claims one.
 *
 *   `--by` chooses what the rows are grouped into, which is what lets #2308's word effect and #2311's region effect be
 *   read in the same units on the same panel. `region-shape` is the crossed one: within each region, the three name
 *   shapes side by side. Two effects reported as pass rates cannot be compared. two margins in logits can be added.
 *
 *   Group by a region-crossed axis whenever the claim is about shape. A pooled `--by shape` run takes its rows in panel
 *   order, panel order is region order, and the rarer shape therefore spans more states than the common one — measured
 *   on the v5.7.0 candidate, the pooled and crossed reads of the same word-count contrast disagree in sign, +0.751
 *   against −0.739 logits.
 *
 *   Pass `--weights-cache` for a candidate. Without it the run grades the installed weights, and the two are not
 *   interchangeable: on the bare admin surface the v5.7.0 candidate sits about 2.5 logits above the shipped line, far
 *   enough that the shipped one saturates against a floor near −6 and the candidate stays additive.
 *
 *   Run:
 *
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --weights-cache <dir>
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --regions AR --swap-postcode 05842
 *       node packages/mailwoman/lib/dev-tools/locality/decode-margins.run.ts --by region-shape --per-group 8
 */

import { matchSubdivisionIn } from "@mailwoman/codex/country"
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
		 * Regions to read, comma-separated.
		 *
		 * Every region in the panel when absent.
		 */
		regions: { type: "string" },
		/**
		 * What the rows are grouped into: `region`, `tail` (the locality's USPS-suffix last word), `shape`
		 * (suffix tail, multi-word, or single word), or `region-shape` (both, which is the crossed read).
		 */
		by: { type: "string", default: "region" },
		/**
		 * Rows to read per group.
		 *
		 * `--per-region` is the older spelling of the same cap and still works.
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
		/**
		 * Resolve each row as well as tracing it, so the decode reading
		 * and the answer reading sit in one table.
		 *
		 * Off by default because it doubles the work: every row costs a trace and then a geocode.
		 */
		"with-geocode": { type: "boolean" },
		/**
		 * Write each row's own region as its canonical name rather than its code — `Illinois` for `IL`.
		 *
		 * Separates the frame from the name: `Orland Park, IL 60467` answers no locality at all while `Orland Park,
		 * Illinois` answers the place, so a penalty read under the coded frame may belong to the frame rather than to the
		 * locality's own shape. A row whose region the codex cannot spell is skipped and counted, never rendered under its
		 * code as though the arm had applied.
		 */
		"spell-region": { type: "boolean" },
		/**
		 * Drop the postcode from the rendered surface, leaving `«locality», «region»`.
		 */
		"drop-postcode": { type: "boolean" },
		/**
		 * Serve with the near-postcode gazetteer choreography off, whatever the card declares.
		 *
		 * The choreography zeroes the gazetteer clue within one piece of a postcode-anchor hit.
		 * It was added to stop the clue on a region token from making the `B-region → B-postcode`
		 * transition uncompetitive, which cost about 3 points of postcode.
		 *
		 * A declared ablation for measurement: the model was trained with the choreography,
		 * so serving it without is a mismatch and never a shipping configuration.
		 */
		"no-gazetteer-suppression": { type: "boolean" },
	},
})

const { localities } = await readCoordPanel(values.eval!, { country: values.country })
const asked = values.regions?.split(",").map((code) => code.trim().toUpperCase())
const perGroup = Number(values["per-group"] ?? values["per-region"])

/**
 * The three name shapes #2308 splits on, in the order its buckets report them.
 *
 * `multi-word` is the control a suffix tail needs, and `(plain)` is not: 3,709 of this
 * panel's 4,803 places are a single word against 577 multi-word and 517 suffix-tailed,
 * so a suffix-versus-everything-else contrast is mostly a contrast between one word and two.
 * Word count moves the rate on its own — #2308 measured single-word names at 79.7%
 * against other multi-word at 59.7% — so it has to be held rather than pooled.
 */
function shapeOf(locality: string): string {
	if (suffixTail(locality)) return "suffix tail"

	return locality.trim().split(/\s+/).length > 1 ? "multi-word" : "single word"
}

/**
 * The grouping axes, each a function from a panel place to the group it counts in.
 *
 * `tail` names the word by its own spelling — a table row reading `-park` says which word carried it —
 * and the `-` prefix keeps a word apart from a shape when a region key is joined to it.
 */
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

/**
 * A BIO label names its tag after the prefix, so both `B-locality`
 * and `I-locality` count as the locality reading.
 */
function isLocalityLabel(label: string): boolean {
	return label.endsWith("-locality") || label === "locality"
}

/**
 * The margin of the locality reading at one token: the best locality label's
 * score minus the best score of any label.
 *
 * Zero when a locality label already wins. negative by how far it lost.
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
	 * Rows whose resolved locality is the expected one, counted only under `--with-geocode`.
	 *
	 * A different question from {@linkcode decodedAsLocality}, and the two are easy to
	 * read as one: the decode reading asks what label the locality's own tokens took,
	 * and this asks what the pipeline finally answered.
	 * A row can lose the locality span and still answer the right place from its region
	 * and postcode, so the second number is the higher one and the gap between them
	 * is how much the region and postcode are carrying.
	 */
	answeredExpected: number
	/**
	 * Rows the pipeline answered with no locality at all.
	 */
	answeredNothing: number
	rawMargin: number
	decodedMargin: number
	priorsApplied: Map<string, number>
	/**
	 * What won at the first locality piece instead.
	 *
	 * A margin says how far the locality came behind. this says what it came behind, which is
	 * the difference between a model that is unsure and one that has learned another reading.
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

		// A crossed pairing denotes no place, and nothing here claims one:
		// the grade is the locality label's margin at the tokens the locality occupies,
		// which is a reading of what the decode conditions on.
		const place = {
			...subject,
			region: spelled ?? values["swap-region"] ?? subject.region,
			postcode: values["drop-postcode"] ? "" : (values["swap-postcode"] ?? subject.postcode),
		}

		const input = renderAdmin(place)
		// `caseCountry`, not `defaultCountry`: the first selects the weights overlay
		// the classifier loads with, which is what a trace is about. the second is a
		// resolver prior `diagnoseParse` never reaches.
		const { trace } = await deps.diagnoseParse(input, { caseCountry: place.country })
		const start = input.indexOf(place.locality)

		// A layout that rewrites the locality (transliteration, a different casing) leaves nothing to index
		// against, and a margin read at the wrong tokens is a number about the wrong part of the string.
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

// The weights go in the header because leaving them out cost a whole reading:
// #2308's rates are measured on a candidate, a bare run grades the installed
// weights instead, and the two sit about 2.5 logits apart on this surface.
// A table that does not name its model can be compared against one that was never its arm.
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

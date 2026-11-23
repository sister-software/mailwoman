// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Report-only measurement of the `siblingLocalityContainment` resolver setting on held-out rows.
 *
 * Each row parses through the Gauntlet's parse path.
 * A row joins the trigger population for a route when its parse tree holds two
 * or more `locality` nodes, the shape the setting reads.
 *
 * Only those rows are geocoded, once with the setting off and once with it on.
 * Each geocode is graded by `scoreGeocodeOutcome`, the outcome the release geocode check reads.
 *
 * Two routes are measured:
 * - `base`: no case country, the CLI's default en-US route.
 * - `country`: the row's country as the case country, the board's routing.
 *
 * `--outside-every k` also geocodes every k-th row outside the population with both arms,
 * to check that the parse-tree count bounds the rows the setting can change.
 *
 * `--setting <name>` measures another setting the same way: `siblingLocalityContainment`
 * (the default) or a decoder setting.
 * A decoder setting's trigger population is the rows whose decoded path the setting changes.
 *
 * `--ids <file>` limits the held-out rows to the ids it lists, one per line.
 *
 * `--inputs` reads a tab-separated literal set (`input<TAB>country`) with no truth, geocoded on both routes.
 *
 * This command isn't a release eval.
 *
 * Usage:
 *
 *     node packages/mailwoman/tools/dev-tools/labels/locality/sibling-locality-census.run.ts --heldout <manifest.json> --limit 200
 *     node packages/mailwoman/tools/dev-tools/labels/locality/sibling-locality-census.run.ts --heldout <manifest.json> --route country --outside-every 50
 *     node packages/mailwoman/tools/dev-tools/labels/locality/sibling-locality-census.run.ts --inputs <input-tab-country.tsv> --label probes
 *
 * It writes `<label>-summary.json` and `<label>-rows.jsonl` to `--out-dir`.
 */

import { collectNodes, buildAddressTree } from "@mailwoman/core/decoder"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile, writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { ResolveNodeTrace } from "@mailwoman/core/resolver"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"

import { DECODER_SETTING_KEYS } from "#geocode/core"
import {
	buildGauntletDeps,
	PRODUCTION_RESOLVER_PINS,
	type GauntletDeps,
	type GauntletGeocodeOpts,
} from "#tools/eval-harness/gauntlet/harness"
import { readHeldoutCollectionRows } from "#tools/eval-harness/heldout/dataset/manifest"
import { heldoutRowID, type HeldoutRow } from "#tools/eval-harness/heldout/per/country"
import { scoreGeocodeOutcome, type HeldoutGeocodeOutcome } from "#tools/eval-harness/heldout/per/geocode/outcome"

const ROUTES = ["base", "country"] as const

type Route = (typeof ROUTES)[number]

const { values } = parseArguments({
	options: {
		heldout: { type: "string", multiple: true },
		inputs: { type: "string" },
		route: { type: "string", multiple: true },
		"out-dir": { type: "string" },
		label: { type: "string" },
		limit: { type: "string" },
		"outside-every": { type: "string" },
		// The setting the two arms differ in.
		setting: { type: "string" },
		// A file of held-out row ids, one per line, that limits the rows read.
		ids: { type: "string" },
	},
})

const MEASURED_SETTINGS = ["siblingLocalityContainment", ...DECODER_SETTING_KEYS] as const

type MeasuredSetting = (typeof MEASURED_SETTINGS)[number]

const setting = (values.setting ?? "siblingLocalityContainment") as MeasuredSetting

if (!(MEASURED_SETTINGS as readonly string[]).includes(setting)) {
	throw new Error(`unknown --setting ${setting}; the settings are ${MEASURED_SETTINGS.join(", ")}`)
}

const decoderSetting = setting !== "siblingLocalityContainment"

const idFilter = values.ids
	? new Set(
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- A list of row ids a census run wrote.
			(await readLocalTextFile(values.ids)).split("\n").filter((line) => line.trim())
		)
	: null

const outDir = values["out-dir"] ?? "/mnt/mw/audits/sibling-heldout"
const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY
const outsideEvery = values["outside-every"] ? Number(values["outside-every"]) : 0
const routes = (values.route?.length ? values.route : ROUTES) as Route[]

for (const route of routes) {
	if (!(ROUTES as readonly string[]).includes(route)) throw new Error(`unknown route ${route}`)
}

interface CensusRow {
	collection: string
	row: HeldoutRow
	graded: boolean
}

async function* censusRows(): AsyncGenerator<CensusRow> {
	if (values.inputs) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- A hand-written literal set of a few dozen lines.
		for (const line of (await readLocalTextFile(values.inputs)).split("\n")) {
			if (!line.trim() || line.startsWith("#")) continue
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- One line of a two-column literal set.
			const [raw, country] = line.split("\t")

			yield {
				collection: "literal",
				graded: false,
				row: {
					raw: raw!,
					span_starts: [],
					span_ends: [],
					span_tags: [],
					country: country?.trim() || null,
					source: "literal",
					source_id: raw!,
					group: raw!,
				},
			}
		}

		return
	}

	for await (const { collection, row } of readHeldoutCollectionRows(values.heldout ?? [])) {
		if (idFilter && !idFilter.has(heldoutRowID(row))) continue

		yield { collection, row, graded: true }
	}
}

interface Answer {
	lat: number | null
	lon: number | null
	tier: string | null
	components: GeocodeResult["components"]
	hierarchy: Array<{ tag: string; value: string; name: string; placeID: string | null }>
	/**
	 * Each locality-family lookup's pick: the span text, its tag and the place it took.
	 */
	picks: Array<{ tag: string; value: string; id: string | number | null; name: string | null; source: string | null }>
	sibling: { inner: string; innerPick: string | number | null; outerID: number | null } | null
	outcome: HeldoutGeocodeOutcome | null
}

function answerOf(row: CensusRow, result: GeocodeResult, trace: ResolveNodeTrace[]): Answer {
	const siblingRecord = trace.find((record) => record.picked?.source === "sibling_locality_containment")

	return {
		lat: result.lat,
		lon: result.lon,
		tier: result.resolution_tier ?? null,
		components: result.components,
		hierarchy: result.hierarchy.map((entry) => ({
			tag: entry.tag,
			value: entry.value,
			name: entry.name,
			placeID: entry.placeID || null,
		})),
		picks: trace
			.filter((record) => record.tag === "locality" || record.tag === "dependent_locality")
			.map((record) => ({
				tag: record.tag,
				value: record.value,
				id: record.picked?.id ?? null,
				name: record.picked?.name ?? null,
				source: record.picked?.source ?? null,
			})),
		sibling: siblingRecord
			? {
					inner: siblingRecord.value,
					innerPick: siblingRecord.picked?.id ?? null,
					outerID: siblingRecord.query.parentQualifierID ?? null,
				}
			: null,
		outcome: row.graded ? scoreGeocodeOutcome(row.row, result) : null,
	}
}

function errorCount(outcome: HeldoutGeocodeOutcome | null): number | null {
	return outcome ? outcome.missing.length + outcome.additional.length + outcome.unplaced.length : null
}

function answersDiffer(off: Answer, on: Answer): boolean {
	return (
		off.lat !== on.lat ||
		off.lon !== on.lon ||
		stringifyJSON(off.components) !== stringifyJSON(on.components) ||
		stringifyJSON(off.hierarchy) !== stringifyJSON(on.hierarchy)
	)
}

type Move = "improved" | "regressed" | "changed-neutral" | "unchanged"

function moveOf(off: Answer, on: Answer): Move {
	if (!answersDiffer(off, on)) return "unchanged"

	if (off.outcome && on.outcome) {
		if (on.outcome.exact !== off.outcome.exact) return on.outcome.exact ? "improved" : "regressed"
		const offErrors = errorCount(off.outcome)!
		const onErrors = errorCount(on.outcome)!

		if (onErrors < offErrors) return "improved"

		if (onErrors > offErrors) return "regressed"
	}

	return "changed-neutral"
}

interface Tally {
	rows: number
	population: number
	fired: number
	improved: number
	regressed: number
	changedNeutral: number
	exactOff: number
	exactOn: number
	outsideSampled: number
	outsideChanged: number
}

const emptyTally = (): Tally => ({
	rows: 0,
	population: 0,
	fired: 0,
	improved: 0,
	regressed: 0,
	changedNeutral: 0,
	exactOff: 0,
	exactOn: 0,
	outsideSampled: 0,
	outsideChanged: 0,
})

const tallies = new Map<string, Tally>()

function tallyFor(route: Route, collection: string, country: string | null): Tally {
	const key = `${route}\t${collection}\t${country ?? "??"}`
	let tally = tallies.get(key)

	if (!tally) {
		tally = emptyTally()
		tallies.set(key, tally)
	}

	return tally
}

interface Receipt {
	route: Route
	collection: string
	id: string
	input: string
	country: string | null
	truth: Array<{ tag: string; text: string }>
	localitySpans: string[]
	outside: boolean
	move: Move
	distanceKm: number | null
	off: Answer
	on: Answer
}

const receipts: Receipt[] = []
const label = values.label ?? (values.inputs ? "literal" : "heldout")
const startedAt = Date.now()
let processed = 0

async function checkpoint(final: boolean): Promise<void> {
	await writeLocalJSONFile(
		{
			label,
			final,
			processed,
			seconds: Math.round((Date.now() - startedAt) / 1000),
			setting,
			routes,
			outsideEvery,
			baseOnlyCountries: [...baseOnly],
			tallies: Object.fromEntries(tallies),
		},
		`${outDir}/${label}-summary.json`
	)

	await writeLocalJSONLFile(receipts, `${outDir}/${label}-rows.jsonl`)
}

async function localitySpans(deps: GauntletDeps, input: string, opts: GauntletGeocodeOpts): Promise<string[]> {
	const { trace } = await deps.diagnoseParse(input, opts)

	const tree = buildAddressTree(
		trace.text,
		trace.tokens,
		trace.containmentCountry ? { country: trace.containmentCountry } : {}
	)

	return collectNodes(tree.roots, (node) => node.tag === "locality").map((node) => node.value)
}

/**
 * Whether a decoder setting changes the row's decoded path, the population a decoder setting is measured on.
 */
async function parseChanges(input: string, opts: GauntletGeocodeOpts): Promise<boolean> {
	const off = await offDeps.diagnoseParse(input, opts)
	const on = await offDeps.diagnoseParse(input, opts, undefined, { [setting]: true })

	return off.trace.path.some((labelIndex, piece) => on.trace.path[piece] !== labelIndex)
}

using offDeps = await buildGauntletDeps({
	pins: { ...PRODUCTION_RESOLVER_PINS, [setting]: "off" },
})

using onDeps = await buildGauntletDeps({
	pins: { ...PRODUCTION_RESOLVER_PINS, [setting]: "on" },
})

const baseOnly = new Set<string>()

for await (const entry of censusRows()) {
	if (processed >= limit) break

	processed++
	const { row } = entry

	for (const route of routes) {
		const opts: GauntletGeocodeOpts = route === "country" && row.country ? { caseCountry: row.country } : {}
		const tally = tallyFor(route, entry.collection, row.country)

		tally.rows++
		const spans = await localitySpans(offDeps, row.raw, opts)
		const inPopulation = decoderSetting ? await parseChanges(row.raw, opts) : spans.length >= 2
		const outside = !inPopulation && outsideEvery > 0 && processed % outsideEvery === 0

		if (route === "country" && row.country && offDeps.gradedBaseOnly(row.country)) {
			baseOnly.add(row.country)
		}

		if (!inPopulation && !outside && !values.inputs) continue

		if (inPopulation) {
			tally.population++
		} else {
			tally.outsideSampled++
		}

		const offRun = await offDeps.geocodeTraced(row.raw, opts)
		const onRun = await onDeps.geocodeTraced(row.raw, opts)
		const off = answerOf(entry, offRun.result, offRun.resolver)
		const on = answerOf(entry, onRun.result, onRun.resolver)
		const move = moveOf(off, on)

		if (!inPopulation && move !== "unchanged") {
			tally.outsideChanged++
		}

		if (inPopulation) {
			if (on.sibling) {
				tally.fired++
			}

			if (off.outcome?.exact) {
				tally.exactOff++
			}

			if (on.outcome?.exact) {
				tally.exactOn++
			}

			if (move === "improved") {
				tally.improved++
			}

			if (move === "regressed") {
				tally.regressed++
			}

			if (move === "changed-neutral") {
				tally.changedNeutral++
			}
		}

		if (move !== "unchanged" || on.sibling || values.inputs) {
			const distanceKm =
				off.lat != null && off.lon != null && on.lat != null && on.lon != null
					? haversine(off.lat, off.lon, on.lat, on.lon)
					: null

			receipts.push({
				route,
				collection: entry.collection,
				id: heldoutRowID(row),
				input: row.raw,
				country: row.country,
				truth: row.span_tags.map((tag, i) => ({ tag, text: row.raw.slice(row.span_starts[i], row.span_ends[i]) })),
				localitySpans: spans,
				outside: !inPopulation,
				move,
				distanceKm,
				off,
				on,
			})
		}
	}

	if (processed % 5000 === 0) {
		console.error(`[sibling-census] ${processed} rows, ${Math.round((Date.now() - startedAt) / 1000)}s`)

		await checkpoint(false)
	}
}

await checkpoint(true)

console.error(`[sibling-census] done: ${processed} rows in ${Math.round((Date.now() - startedAt) / 1000)}s`)

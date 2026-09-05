/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which inputs a measurement runs over, and what that choice costs.
 *
 *   The design rule (spec §5.1) is that the well-powered thing must be the CHEAPEST thing to type. `{kind:"board"}` is
 *   the shortest legal value and default everywhere. A hand-picked list requires an array AND a `why` string,
 *   so choosing a small sample is a deliberate act that leaves a record in the result. This inverts the incentive that
 *   produced nine one-off probe scripts in a day, each with a panel its author chose and nobody reviewed.
 *
 *   Every resolved set carries its `sha256`, its selection kind and — where it is a subset — the size of the set it was
 *   drawn from, because a denominator that travels with the number is the only kind that survives a relay.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { mulberry32 } from "@mailwoman/core/random"
import { ladderRungs } from "mailwoman/eval-harness/autocomplete-ladder"
import { loadRegressionCases, regressionCorpusHash } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import { drawHoldoutSample, holdoutSources } from "mailwoman/eval-harness/gauntlet/holdout"
import { routeCountry } from "mailwoman/eval-harness/gauntlet/routing"

import type { Selection } from "#power"

/**
 * Repo-relative home of the triaged parity fixtures — the same literal `parity-corpus.ts` exports as
 * `PARITY_FIXTURES_PATH`, kept here as a constant rather than an inline string so a move breaks one place.
 */
const PARITY_FIXTURES_RELATIVE_PATH = "packages/mailwoman/lib/eval-harness/fixtures/parity-corpus.triaged.jsonl"

/**
 * A reference to an input set. Discriminated so a caller cannot pass a bare array by accident — see the module
 * docstring for why the hand-picked case is deliberately the wordy one.
 */
export type InputSetRef =
	| { kind: "board"; country?: string; address_kind?: string; status?: string }
	| { kind: "panel"; version?: PanelVersion; country?: string; truth_type?: string }
	| { kind: "golden"; version?: string; split?: GoldenSplit }
	| { kind: "parity"; country?: string }
	| { kind: "holdout"; source?: HoldoutSource; n?: number; seed?: number }
	| { kind: "ladder"; country?: string; address_kind?: string; status?: string }
	| {
			kind: "literal"
			inputs: Array<string | LiteralInputWithTruth>
			why: string
	  }

/**
 * Held-out truth sources. `fr` is BAN, `us` is FDIC — the two `gauntlet/holdout.ts` defines, named here so a caller
 * gets a closed set rather than a string that fails at read time.
 */
export const HOLDOUT_SOURCES = ["fr", "us"] as const

type HoldoutSource = (typeof HOLDOUT_SOURCES)[number]

/**
 * Default holdout draw size. Matches `runHoldoutLayer`'s own default, so a set drawn here is the size the eval is
 * calibrated on.
 */
export const HOLDOUT_DEFAULT_N = 300

/**
 * Benchmark panels, by version. Each is a fixed file under `$MAILWOMAN_DATA_ROOT/pelias-rig/panel/`; v2 is the 420-row
 * set the head-to-head protocol was pre-registered against.
 */
const PANEL_VERSIONS = ["v1", "v2", "v2.1", "v3", "v3.1"] as const

type PanelVersion = (typeof PANEL_VERSIONS)[number]

/**
 * Golden splits. `dev` is the tuning half and the one an iterating change may look at; the top-level files are the
 * held-back half, so reaching for them casually is how a held-out set stops being held out.
 */
const GOLDEN_SPLITS = ["dev", "full"] as const

type GoldenSplit = (typeof GOLDEN_SPLITS)[number]

/**
 * A hand-picked input that carries its own truth point.
 *
 * `lat`/`lon` are an ASSERTION by whoever wrote the call. Nothing here verifies them, so the set's `why` has to say
 * where they came from — a resolved map link, an oracle, a survey. An invented pin grades nothing and looks identical
 * to a real one in the output.
 */
export interface LiteralInputWithTruth {
	input: string
	lat: number
	lon: number
	tolerance_m?: number
	truth_type?: string
}

export interface ResolvedInput {
	/**
	 * Case id for a board row; for a literal input, the input's own index. Carried so a result row can be traced back.
	 */
	id: string
	input: string
	country?: string
	/**
	 * Runtime overlay route. Board rows derive this from explicit locale region first, then truth country.
	 */
	routeCountry?: string
	/**
	 * Locale-region hint that scopes the fuzzy resolver tier on board rows.
	 */
	fuzzyCountryScope?: string
	/**
	 * Row-specific resolver country assertion from the board.
	 */
	defaultCountry?: string
	addressKind?: string
	status?: string
	/**
	 * The case's expectations, when it has any. Present so a caller can grade; absent for literal inputs, which have no
	 * truth attached and therefore cannot be graded — only observed.
	 */
	seed?: SeedCase
	/**
	 * Truth COORDINATE, when the row carries one — the only axis a cross-engine comparison has.
	 *
	 * Populated here for every corpus rather than read off `seed` by the caller, because only the board has a `SeedCase`
	 * and a panel row does not. One field means `mwdev_compare` does not have to know which corpus a row came from, which
	 * is what keeps a second truth path from appearing the first time a new set is added.
	 */
	truthLat?: number
	truthLon?: number
	/**
	 * How the truth point was established — `rooftop`, `parcel`, `interpolated`, `centroid`. Panels carry it and the
	 * benchmark plan is explicit that a headline "@1km lives or dies on `truth_type`", so it is stratifiable rather than
	 * blended.
	 */
	truthType?: string
	/**
	 * Per-row distance tolerance in metres, when the corpus pins one. `undefined` means the caller's threshold applies.
	 */
	toleranceM?: number
	/**
	 * Component expectations for a corpus that has them but no `SeedCase` — golden and parity both do. Without this the
	 * truth census reads them as carrying nothing, which is how a 4,255-row golden set reported `none: 4255`.
	 */
	expectComponents?: Record<string, string>
}

export interface ResolvedInputSet {
	setID: string
	inputs: ResolvedInput[]
	n: number
	sha256: string
	selection: Selection
	/**
	 * Size of the set this was drawn from, when this is a subset. `undefined` for a full board.
	 */
	populationN?: number
	/**
	 * Required and echoed for a hand-picked set. It appears in every result derived from the set, so the reason for a
	 * small panel is visible next to the number it produced.
	 */
	why?: string
	/**
	 * Strata present in the population but ABSENT from this set — the answer to "what would this panel have been blind
	 * to?", available before the run rather than after. Empty for a full board.
	 */
	notCovered: string[]
	/**
	 * How many rows carry each kind of truth.
	 *
	 * The per-kind counts OVERLAP — a row can pin components and a coordinate and a tier — so they must never be summed.
	 * `any` is the distinct row count and `none` its complement; those two are what add up to `n`. An earlier draft
	 * summed the three and reported 839 rows carrying truth on a 558-row board, which is the shape of every
	 * double-counted denominator.
	 */
	hasTruth: { components: number; coordinates: number; tier: number; any: number; none: number }
	/**
	 * The live corpus hash, for a board-derived set. Recomputed on every resolve and never cached: a cached stamp verdict
	 * is the 2026-08-06 failure with extra steps.
	 */
	corpusHash?: string
	notes: string[]
}

function countStrata(cases: SeedCase[], pick: (c: SeedCase) => string | undefined): Map<string, number> {
	const counts = new Map<string, number>()

	for (const row of cases) {
		const key = pick(row)

		if (!key) continue

		counts.set(key, (counts.get(key) ?? 0) + 1)
	}

	return counts
}

function truthCounts(cases: SeedCase[]): ResolvedInputSet["hasTruth"] {
	let components = 0
	let coordinates = 0
	let tier = 0
	let any = 0
	let none = 0

	for (const row of cases) {
		const hasComponents = Boolean(row.expectComponents || row.expectComponentRenderings)
		const hasCoordinates = typeof row.expectLat === "number" && typeof row.expectLon === "number"
		const hasTier = Boolean(row.expectTier)

		if (hasComponents) {
			components++
		}

		if (hasCoordinates) {
			coordinates++
		}

		if (hasTier) {
			tier++
		}

		if (hasComponents || hasCoordinates || hasTier) {
			any++
		} else {
			none++
		}
	}

	return { components, coordinates, tier, any, none }
}

/**
 * Resolve a reference into the rows it names.
 *
 * A board slice reports what it excluded, not merely what it kept. That asymmetry is the point: a caller who filters to
 * `country: "gb"` is told which countries just left the measurement, in the same object that carries the result.
 */
export async function resolveInputSet(ref: InputSetRef): Promise<ResolvedInputSet> {
	switch (ref.kind) {
		case "literal":
			return resolveLiteral(ref)
		case "board":
			return resolveBoard(ref)
		case "panel":
			return resolvePanel(ref)
		case "golden":
			return resolveGolden(ref)
		case "parity":
			return resolveParity(ref)
		case "holdout":
			return resolveHoldout(ref)
		case "ladder":
			return resolveLadder(ref)
	}
}

/**
 * The autocomplete ladder over a board filter (#2154): every board row that carries a coordinate truth, expanded into
 * its prefix rungs — the input truncated at each token boundary plus the first three single characters — with each rung
 * graded against the ROW's truth and tolerance. This is what lets `mwdev_compare` run two arms over partial queries
 * under the same grading and significance report as a finished one; `mailwoman eval autocomplete` reads the ladder in
 * its own top-k terms, and the full-string rung here must equal the ordinary board grade for the row.
 *
 * The locale hint is part of the input contract: a two-letter prefix carries no country evidence of its own, so every
 * rung runs with the row's country as its route, its fuzzy scope and its default country. A rung measured without the
 * hint would grade the gazetteer's population prior, not autocomplete.
 */
async function resolveLadder(ref: Extract<InputSetRef, { kind: "ladder" }>): Promise<ResolvedInputSet> {
	const board = await resolveBoard({
		kind: "board",
		...(ref.country ? { country: ref.country } : {}),
		...(ref.address_kind ? { address_kind: ref.address_kind } : {}),
		...(ref.status ? { status: ref.status } : {}),
	})

	const withTruth = board.inputs.filter((row) => typeof row.truthLat === "number" && typeof row.truthLon === "number")
	const rungs: ResolvedInput[] = []

	for (const row of withTruth) {
		for (const rung of ladderRungs(row.input)) {
			rungs.push({
				...row,
				id: `${row.id}@${rung.length}`,
				input: rung,
				routeCountry: row.routeCountry ?? row.country,
				fuzzyCountryScope: row.fuzzyCountryScope ?? row.country,
				defaultCountry: row.defaultCountry ?? row.country,
			})
		}
	}

	const slug = board.setID.replace(/^board/, "ladder")

	return {
		setID: slug,
		inputs: rungs,
		n: rungs.length,
		sha256: sha256Hex(rungs.map((r) => `${r.id}\t${r.input}`)),
		selection: "slice",
		populationN: board.populationN ?? board.n,
		notCovered: [
			...board.notCovered,
			...(withTruth.length !== board.inputs.length
				? [`${board.inputs.length - withTruth.length} board rows carry no coordinate truth and have no ladder`]
				: []),
		],
		hasTruth: truthCounts(rungs.map((r) => r.seed).filter(isPresent)),
		corpusHash: board.corpusHash,
		notes: [
			`${withTruth.length} board rows expanded into ${rungs.length} prefix rungs; a row's id becomes <id>@<rung length>.`,
			"Every rung is graded at its ROW's truth and tolerance, and runs with the row's country as the locale hint (route, fuzzy scope and default country) — a prefix carries no country evidence of its own.",
			"The full-string rung of each row must equal the ordinary board grade for that row and arm; a difference is a harness defect, not a finding.",
		],
	}
}

/**
 * A fresh draw from a held-out truth source — the only set here the model cannot have memorized.
 *
 * REPRODUCIBILITY IS OPT-IN, and the default is the unseeded draw. A seeded default would be the more convenient choice
 * and it would quietly convert the one generalization measure in this file into a fixed corpus that the next training
 * run can absorb. `seed` is there for the case that genuinely needs it — re-running one arm later, or a
 * `{kind:"recorded"}` comparison, both of which require the two runs to see the same rows — and the result says which
 * of the two happened.
 *
 * COST, measured 2026-08-16 on this box, because a reservoir draw reads the entire source: **`us` 113 ms over 77,442
 * parseable rows; `fr` 45.5 s over 26,721,353 rows** (BAN is a 5.06 GB CSV). The FR draw is therefore a per-call cost
 * on the order of a minute, not a cached one — there is nowhere to cache it that would not defeat the freshness the set
 * exists for.
 */
async function resolveHoldout(ref: Extract<InputSetRef, { kind: "holdout" }>): Promise<ResolvedInputSet> {
	const source = ref.source ?? "fr"
	const n = ref.n ?? HOLDOUT_DEFAULT_N
	const definition = holdoutSources()[source]

	if (!definition) {
		throw new Error(
			`input set: unknown holdout source ${JSON.stringify(source)}. Known: ${HOLDOUT_SOURCES.join(", ")}.`
		)
	}

	if (!(await pathExists(definition.file))) {
		throw new Error(
			`input set: the ${definition.label} staging file is not at ${definition.file}. Refusing rather than resolving ` +
				"to an empty set — a run over zero rows reports zero differences, which reads as no effect."
		)
	}

	const { sample, drawnFrom } = await drawHoldoutSample(
		definition,
		n,
		ref.seed === undefined ? undefined : mulberry32(ref.seed)
	)

	if (!sample.length) {
		throw new Error(`input set: the ${definition.label} draw produced no rows from ${definition.file}.`)
	}

	const inputs: ResolvedInput[] = sample.map((row, index) => ({
		id: `${source}-${index}`,
		input: row.query,
		country: source.toUpperCase(),
		truthLat: row.lat,
		truthLon: row.lon,
		// Every row in both sources is a house-number address point from a national register, so the truth is a rooftop
		// rather than a centroid. Stated per row so a stratified report reads the same way it does for a panel.
		truthType: "rooftop",
	}))

	return {
		setID: `holdout:${source}/${n}${ref.seed === undefined ? "" : `/seed-${ref.seed}`}`,
		inputs,
		n: inputs.length,
		sha256: sha256Hex(inputs.map((row) => `${row.id}\t${row.input}`)),
		selection: "random-draw",
		populationN: drawnFrom,
		notCovered: [
			"Everything the source itself excludes: both parsers keep only rows with a house number, a street and a " +
				"locality, and drop the postcode to leave the bare form.",
		],
		hasTruth: coordinateTruthCounts(inputs),
		notes: [
			`${definition.label}, ${inputs.length} rows drawn from ${drawnFrom.toLocaleString("en-US")} parseable rows.`,
			ref.seed === undefined
				? "UNSEEDED — a genuinely fresh draw. Re-running this reference produces different rows, which is what makes " +
					"it the one set the model cannot have memorized. Two arms inside a single call still see the same rows."
				: `Seeded with ${ref.seed}, so this exact set is reproducible. That also means it can be iterated against, ` +
					"which is how a held-out set stops being held out — use a seed to re-run a comparison, not to tune.",
		],
	}
}

/**
 * A hand-picked list. See {@link INPUT_SET_SCHEMA} for why `why` is required.
 */
async function resolveLiteral(ref: Extract<InputSetRef, { kind: "literal" }>): Promise<ResolvedInputSet> {
	if (!ref.inputs.length) throw new Error("input set: a literal set needs at least one input")

	if (!ref.why?.trim()) {
		throw new Error(
			"input set: a literal set requires `why`. A hand-picked panel is a claim about what is worth measuring, " +
				"and the claim is recorded next to every number the set produces."
		)
	}

	// A row may carry its own truth point. That is what turns this from an observation set into the AUTHORING loop
	// for a new board row: measure the candidates against real coordinates first, then write the case file with the
	// status you measured — rather than writing rows and discovering the score afterwards.
	const rows: ResolvedInput[] = ref.inputs.map((entry, index) =>
		typeof entry === "string"
			? { id: String(index), input: entry }
			: {
					id: String(index),
					input: entry.input,
					truthLat: entry.lat,
					truthLon: entry.lon,
					...(entry.tolerance_m === undefined ? {} : { toleranceM: entry.tolerance_m }),
					...(entry.truth_type === undefined ? {} : { truthType: entry.truth_type }),
				}
	)

	const graded = rows.filter((row) => row.truthLat !== undefined).length
	// The digest keys on what was MEASURED — input plus its truth point — so two sets that share inputs but pin
	// different coordinates cannot collide on `setID` and be read as the same run.
	const digest = rows.map((row) => `${row.input}\u0000${row.truthLat ?? ""}\u0000${row.truthLon ?? ""}`)

	return {
		setID: `literal:${sha256Hex(digest).slice(0, 12)}`,
		inputs: rows,
		n: rows.length,
		sha256: sha256Hex(digest),
		selection: "hand-picked",
		why: ref.why,
		notCovered: [],
		hasTruth: {
			components: 0,
			coordinates: graded,
			tier: 0,
			any: graded,
			none: rows.length - graded,
		},
		notes: [
			graded === 0
				? "Hand-picked inputs carry no expectations, so this set can be observed but not graded."
				: graded === rows.length
					? `All ${graded} rows carry a truth COORDINATE, so this set grades on distance. It carries no component or ` +
						"tier truth — a row can be right to the metre and still have parsed the wrong thing."
					: `${graded} of ${rows.length} rows carry a truth coordinate; the rest are observed only. Read the graded ` +
						"fraction against its own denominator, never against n.",
			"Results from this set report their confidence bound in the summary sentence — see power.ts.",
		],
	}
}

/**
 * The regression board, optionally sliced.
 */
async function resolveBoard(ref: Extract<InputSetRef, { kind: "board" }>): Promise<ResolvedInputSet> {
	const all = await loadRegressionCases()

	const corpusHash = regressionCorpusHash(all)

	const filtered = all.filter((row) => {
		if (ref.country && row.country.toLowerCase() !== ref.country.toLowerCase()) return false

		if (ref.address_kind && row.addressKind !== ref.address_kind) return false

		if (ref.status && row.status !== ref.status) return false

		return true
	})

	const isSlice = filtered.length !== all.length
	const notCovered: string[] = []

	if (isSlice) {
		const keptCountries = new Set(filtered.map((r) => r.country))
		const droppedCountries = [...new Set(all.map((r) => r.country))].filter((c) => !keptCountries.has(c))
		const keptKinds = new Set(filtered.map((r) => r.addressKind))
		const droppedKinds = [...countStrata(all, (r) => r.addressKind).keys()].filter((k) => !keptKinds.has(k))

		if (droppedCountries.length) {
			notCovered.push(`countries excluded: ${droppedCountries.toSorted().join(", ")}`)
		}

		if (droppedKinds.length) {
			notCovered.push(`address kinds excluded: ${droppedKinds.toSorted().join(", ")}`)
		}
	}

	const slugParts = [ref.country, ref.address_kind, ref.status].filter(isPresent)

	return {
		setID: slugParts.length ? `board:${slugParts.join("/")}` : "board",
		inputs: filtered.map((seed) => ({
			id: seed.id,
			input: seed.input,
			country: seed.country,
			routeCountry: routeCountry(seed),
			...(seed.locale?.split("-")[1] ? { fuzzyCountryScope: seed.locale.split("-")[1] } : {}),
			...(seed.defaultCountry ? { defaultCountry: seed.defaultCountry } : {}),
			addressKind: seed.addressKind,
			status: seed.status,
			seed,
			...(typeof seed.expectLat === "number" && typeof seed.expectLon === "number"
				? { truthLat: seed.expectLat, truthLon: seed.expectLon }
				: {}),
			...(seed.expectToleranceM === undefined ? {} : { toleranceM: seed.expectToleranceM }),
		})),
		n: filtered.length,
		sha256: sha256Hex(filtered.map((r) => `${r.id}\t${r.input}`)),
		selection: isSlice ? "slice" : "full",
		...(isSlice ? { populationN: all.length } : {}),
		notCovered,
		hasTruth: truthCounts(filtered),
		corpusHash,
		notes: isSlice
			? [`Declared slice of the ${all.length}-row board.`]
			: [`The full regression board, ${all.length} rows, corpus ${corpusHash.slice(0, 12)}.`],
	}
}

/**
 * One JSONL corpus row, read loosely because these files are operator artifacts rather than a schema this repo owns.
 */
interface CorpusRow {
	id?: string
	input?: string
	raw?: string
	country?: string
	locale?: string
	truth_lat?: number
	truth_lon?: number
	truth_type?: string
	tolerance_m?: number | null
	expect?: Record<string, string[] | string>
	components?: Record<string, string>
}

/**
 * Read a JSONL corpus, or say precisely which file was missing.
 *
 * A corpus that cannot be read must NOT resolve to an empty set: a measurement over zero rows reports zero differences,
 * which reads as "no effect" rather than "nothing ran".
 */
async function readCorpus(path: string, what: string): Promise<CorpusRow[]> {
	if (!(await pathExists(path))) {
		throw new Error(
			`${what} not found at ${path}. Refusing rather than resolving to an empty set — a run over zero rows reports ` +
				"zero differences, which reads as no effect."
		)
	}

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a fixed operator artifact of a few hundred rows, read once
	return (await readLocalTextFile(path))
		.split("\n")
		.filter(isPresent)
		.map((line) => parseJSONStrict<CorpusRow>(line))
}

/**
 * Truth census for a coordinate-bearing corpus, where `components` is the only non-coordinate expectation available.
 */
function coordinateTruthCounts(rows: ResolvedInput[]): ResolvedInputSet["hasTruth"] {
	let coordinates = 0
	let components = 0
	let any = 0
	let none = 0

	for (const row of rows) {
		const hasCoordinates = typeof row.truthLat === "number" && typeof row.truthLon === "number"
		const hasComponents = Boolean(row.seed?.expectComponents ?? row.expectComponents)

		if (hasCoordinates) {
			coordinates++
		}

		if (hasComponents) {
			components++
		}

		if (hasCoordinates || hasComponents) {
			any++
		} else {
			none++
		}
	}

	return { components, coordinates, tier: 0, any, none }
}

/**
 * A benchmark panel — the corpus the head-to-head protocol was pre-registered against.
 *
 * `truthType` is carried per row and NEVER blended away: the benchmark plan's own words are that a headline "@1km lives
 * or dies on `truth_type`", so a caller that reports one number across rooftop and centroid rows has reported a number
 * about its own row mix.
 */
async function resolvePanel(ref: Extract<InputSetRef, { kind: "panel" }>): Promise<ResolvedInputSet> {
	const version = ref.version ?? "v2"
	const path = String(dataRootPath("pelias-rig", "panel", `panel-${version}.jsonl`))
	const all = await readCorpus(path, `panel ${version}`)

	const filtered = all.filter((row) => {
		if (ref.country && (row.country ?? "").toUpperCase() !== ref.country.toUpperCase()) return false

		if (ref.truth_type && row.truth_type !== ref.truth_type) return false

		return true
	})

	const inputs: ResolvedInput[] = filtered.map((row, index) => ({
		id: row.id ?? String(index),
		input: row.input ?? row.raw ?? "",
		...(row.country ? { country: row.country } : {}),
		...(typeof row.truth_lat === "number" && typeof row.truth_lon === "number"
			? { truthLat: row.truth_lat, truthLon: row.truth_lon }
			: {}),
		...(row.truth_type ? { truthType: row.truth_type } : {}),
		...(typeof row.tolerance_m === "number" ? { toleranceM: row.tolerance_m } : {}),
	}))

	const isSlice = filtered.length !== all.length
	const notCovered: string[] = []

	if (isSlice) {
		const keptTypes = new Set(filtered.map((row) => row.truth_type))
		const dropped = [...new Set(all.map((row) => row.truth_type))].filter((t) => t && !keptTypes.has(t))

		if (dropped.length) {
			notCovered.push(`truth types excluded: ${dropped.join(", ")}`)
		}
	}

	const slug = [version, ref.country, ref.truth_type].filter(isPresent).join("/")

	return {
		setID: `panel:${slug}`,
		inputs,
		n: inputs.length,
		sha256: sha256Hex(inputs.map((row) => `${row.id}\t${row.input}`)),
		selection: isSlice ? "slice" : "full",
		...(isSlice ? { populationN: all.length } : {}),
		notCovered,
		hasTruth: coordinateTruthCounts(inputs),
		notes: [
			`Benchmark panel ${version}, ${all.length} rows${isSlice ? ` sliced to ${inputs.length}` : ""}.`,
			"Carries truth_type — report stratified by it rather than blended.",
		],
	}
}

/**
 * A golden set. `dev` is the tuning split; the top-level files are the held-back half.
 */
async function resolveGolden(ref: Extract<InputSetRef, { kind: "golden" }>): Promise<ResolvedInputSet> {
	const version = ref.version ?? "v0.1.3"
	const split = ref.split ?? "dev"
	const base = String(dataRootPath("eval", "golden", version))
	const dir = split === "dev" ? `${base}/dev` : base

	const inputs: ResolvedInput[] = []

	for (const locale of ["us", "fr", "adversarial"]) {
		const path = `${dir}/${locale}.jsonl`

		if (!(await pathExists(path))) continue

		for (const [index, row] of (await readCorpus(path, `golden ${version}/${split}/${locale}`)).entries()) {
			inputs.push({
				id: row.id ?? `${locale}-${index}`,
				input: row.raw ?? row.input ?? "",
				...(locale === "adversarial" ? {} : { country: locale.toUpperCase() }),
				...(row.components ? { expectComponents: row.components } : {}),
			})
		}
	}

	if (!inputs.length) {
		throw new Error(
			`golden ${version}/${split} resolved no rows under ${dir}. Refusing rather than measuring an empty set.`
		)
	}

	return {
		setID: `golden:${version}/${split}`,
		inputs,
		n: inputs.length,
		sha256: sha256Hex(inputs.map((row) => `${row.id}\t${row.input}`)),
		selection: "full",
		notCovered: split === "dev" ? ['the held-back split — `split: "full"` reaches it, deliberately separately'] : [],
		hasTruth: coordinateTruthCounts(inputs),
		notes: [
			`Golden ${version}, ${split} split, ${inputs.length} rows.`,
			split === "dev"
				? "The TUNING half. Iterating against it is fine; quoting it as held-out evidence is not."
				: "The HELD-BACK half. Reading it repeatedly while iterating is how a held-out set stops being one.",
		],
	}
}

/**
 * The triaged parse-parity fixtures — component expectations, no coordinates.
 */
async function resolveParity(ref: Extract<InputSetRef, { kind: "parity" }>): Promise<ResolvedInputSet> {
	const path = String(repoRootPath(PARITY_FIXTURES_RELATIVE_PATH))
	const raw = await readCorpus(path, "parity corpus")

	// The SAME live filter `parity-corpus.ts` applies: 22 rules-era no-solution assertions plus 33 gold-triage
	// tombstones are fixtures a neural parser must not be graded against. Feeding them in would quietly inflate the
	// denominator with rows that cannot pass.
	const all = raw.filter((row) => !(row as { dropped?: boolean }).dropped && row.expect)
	const tombstones = raw.length - all.length

	const filtered = ref.country
		? all.filter((row) => (row.country ?? "").toUpperCase() === ref.country!.toUpperCase())
		: all

	const inputs: ResolvedInput[] = filtered.map((row, index) => ({
		id: row.id ?? String(index),
		input: row.input ?? row.raw ?? "",
		...(row.country ? { country: row.country } : {}),
		...(row.expect ? { expectComponents: row.expect as Record<string, string> } : {}),
	}))

	const isSlice = filtered.length !== all.length

	return {
		setID: ref.country ? `parity:${ref.country}` : "parity",
		inputs,
		n: inputs.length,
		sha256: sha256Hex(inputs.map((row) => `${row.id}\t${row.input}`)),
		selection: isSlice ? "slice" : "full",
		...(isSlice ? { populationN: all.length } : {}),
		notCovered: isSlice
			? [`countries excluded: ${[...new Set(all.map((r) => r.country))].filter((c) => c !== ref.country).join(", ")}`]
			: [],
		// Component expectations only. `coordinateTruthCounts` reports 0 coordinates, which is the honest reading: this
		// corpus cannot support a distance claim however many rows it has.
		hasTruth: { components: inputs.length, coordinates: 0, tier: 0, any: inputs.length, none: 0 },
		notes: [
			`Parity corpus, ${all.length} live fixtures (${tombstones} tombstones skipped)${isSlice ? `, sliced to ${inputs.length}` : ""}.`,
			"Component expectations only — NO coordinates, so a cross-engine distance comparison cannot be graded on it.",
		],
	}
}

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolves measurement input sets and reports each set's selection, size, truth coverage and content hash.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { mulberry32 } from "@mailwoman/core/random"
import { ladderRungs } from "mailwoman/eval-harness/autocomplete-ladder"
import { loadRegressionCases, regressionCorpusHash } from "mailwoman/eval-harness/gauntlet/cases/load"
import type { SeedCase } from "mailwoman/eval-harness/gauntlet/cases/seed-case"
import { drawHoldoutSample, holdoutSources } from "mailwoman/eval-harness/gauntlet/holdout"
import { routeCountry } from "mailwoman/eval-harness/gauntlet/routing"
import type { PathBuilderLike } from "path-ts"

import type { Selection } from "#power"

const PARITY_FIXTURES_RELATIVE_PATH = "packages/mailwoman/lib/eval-harness/fixtures/parity-corpus.triaged.jsonl"

/**
 * A reference to one input set, discriminated by `kind`.
 *
 * A `literal` set must carry `why`, the rationale for the hand-picked inputs.
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
 * The held-out sources: BAN for France and FDIC for the United States.
 */
export const HOLDOUT_SOURCES = ["fr", "us"] as const

type HoldoutSource = (typeof HOLDOUT_SOURCES)[number]

/**
 * The default number of rows in a holdout draw.
 */
export const HOLDOUT_DEFAULT_N = 300

const PANEL_VERSIONS = ["v1", "v2", "v2.1", "v3", "v3.1"] as const

type PanelVersion = (typeof PANEL_VERSIONS)[number]

/**
 * The golden splits.
 *
 * `dev` is the tuning split, and `full` includes the held-back rows.
 */
const GOLDEN_SPLITS = ["dev", "full"] as const

type GoldenSplit = (typeof GOLDEN_SPLITS)[number]

/**
 * A hand-picked input with a caller-supplied truth coordinate.
 */
export interface LiteralInputWithTruth {
	input: string
	lat: number
	lon: number
	tolerance_m?: number
	truth_type?: string
}

/**
 * One input row with its routing hints and truth.
 */
export interface ResolvedInput {
	/**
	 * The source case ID, or the index of a literal input.
	 */
	id: string
	input: string
	country?: string
	/**
	 * The country overlay used for runtime routing.
	 */
	routeCountry?: string
	/**
	 * The locale region that scopes the fuzzy resolver tier on board rows.
	 */
	fuzzyCountryScope?: string
	/**
	 * The board row's own resolver country.
	 */
	defaultCountry?: string
	addressKind?: string
	status?: string
	/**
	 * The board case with its expectations.
	 * Literal inputs have none.
	 */
	seed?: SeedCase
	/**
	 * The truth coordinate for distance grading.
	 */
	truthLat?: number
	truthLon?: number
	/**
	 * The provenance type of the truth point, used for stratification.
	 */
	truthType?: string
	/**
	 * The row's distance tolerance in metres.
	 */
	toleranceM?: number
	/**
	 * The expected components of a golden or parity row.
	 */
	expectComponents?: Record<string, string>
}

/**
 * A resolved input set with its provenance and truth coverage.
 */
export interface ResolvedInputSet {
	setID: string
	inputs: ResolvedInput[]
	n: number
	sha256: string
	selection: Selection
	/**
	 * The size of the population a subset was drawn from.
	 */
	populationN?: number
	/**
	 * The rationale for a hand-picked set, repeated in results.
	 */
	why?: string
	/**
	 * The population strata this set excludes.
	 */
	notCovered: string[]
	/**
	 * Row counts by truth type.
	 *
	 * The type counts may overlap.
	 * The `any` and `none` counts partition the rows.
	 */
	hasTruth: { components: number; coordinates: number; tier: number; any: number; none: number }
	/**
	 * The regression corpus hash of a board-derived set.
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
 * Resolves a reference to its rows, excluded strata and notes.
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
 * Expands each board row that has a truth coordinate into autocomplete prefixes.
 *
 * Each prefix keeps its row's truth, tolerance and country hints.
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
		selection: "subset",
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
 * Draws a sample from a held-out source.
 *
 * The draw is unseeded by default.
 * A seed reproduces the same sample.
 */
async function resolveHoldout(ref: Extract<InputSetRef, { kind: "holdout" }>): Promise<ResolvedInputSet> {
	const source = ref.source ?? "fr"
	const n = ref.n ?? HOLDOUT_DEFAULT_N
	const definition = holdoutSources()[source]

	if (!definition) {
		throw new Error(`input set: unknown holdout source ${stringifyJSON(source)}. Known: ${HOLDOUT_SOURCES.join(", ")}.`)
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
		// Both sources are national house-number address points.
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
 * Resolves a caller-selected list of inputs.
 */
async function resolveLiteral(ref: Extract<InputSetRef, { kind: "literal" }>): Promise<ResolvedInputSet> {
	if (!ref.inputs.length) throw new Error("input set: a literal set needs at least one input")

	if (!ref.why?.trim()) {
		throw new Error(
			"input set: a literal set requires `why`. A hand-picked panel is a claim about what is worth measuring, " +
				"and the claim is recorded next to every number the set produces."
		)
	}

	// A literal input with coordinates can be graded.
	// A bare string can only be observed.
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
	// The digest includes the truth coordinates, so sets graded differently get different IDs.
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
 * Resolves the full regression board or a filtered subset.
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

	const isSubset = filtered.length !== all.length
	const notCovered: string[] = []

	if (isSubset) {
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
		selection: isSubset ? "subset" : "full",
		...(isSubset ? { populationN: all.length } : {}),
		notCovered,
		hasTruth: truthCounts(filtered),
		corpusHash,
		notes: isSubset
			? [`Declared subset of the ${all.length}-row board.`]
			: [`The full regression board, ${all.length} rows, corpus ${corpusHash.slice(0, 12)}.`],
	}
}

/**
 * One row of a JSONL corpus.
 *
 * Every field is optional because the files come from outside this package.
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
 * Reads a JSONL corpus.
 *
 * @throws When the file is missing.
 * An empty set would report zero differences and look like no effect.
 */
async function readCorpus(path: PathBuilderLike, what: string): Promise<CorpusRow[]> {
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
 * Counts truth for rows whose only possible expectations are coordinates and components.
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
 * Resolves a benchmark panel and keeps each row's truth type.
 */
async function resolvePanel(ref: Extract<InputSetRef, { kind: "panel" }>): Promise<ResolvedInputSet> {
	const version = ref.version ?? "v2"
	const path = dataRootPath("pelias-rig", "panel", `panel-${version}.jsonl`)
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

	const isSubset = filtered.length !== all.length
	const notCovered: string[] = []

	if (isSubset) {
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
		selection: isSubset ? "subset" : "full",
		...(isSubset ? { populationN: all.length } : {}),
		notCovered,
		hasTruth: coordinateTruthCounts(inputs),
		notes: [
			`Benchmark panel ${version}, ${all.length} rows${isSubset ? ` filtered to ${inputs.length}` : ""}.`,
			"Carries truth_type — report stratified by it rather than blended.",
		],
	}
}

/**
 * Resolves the `dev` or `full` golden split.
 */
async function resolveGolden(ref: Extract<InputSetRef, { kind: "golden" }>): Promise<ResolvedInputSet> {
	const version = ref.version ?? "v0.1.3"
	const split = ref.split ?? "dev"
	const base = dataRootPath("eval", "golden", version)
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
 * Resolves the parse-parity fixtures, which carry component expectations only.
 */
async function resolveParity(ref: Extract<InputSetRef, { kind: "parity" }>): Promise<ResolvedInputSet> {
	const path = repoRootPath(PARITY_FIXTURES_RELATIVE_PATH)
	const raw = await readCorpus(path, "parity corpus")

	// This matches the filter in `parity-corpus.ts`.
	// Dropped rows and rows without `expect` cannot pass, so counting them would inflate the denominator.
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

	const isSubset = filtered.length !== all.length

	return {
		setID: ref.country ? `parity:${ref.country}` : "parity",
		inputs,
		n: inputs.length,
		sha256: sha256Hex(inputs.map((row) => `${row.id}\t${row.input}`)),
		selection: isSubset ? "subset" : "full",
		...(isSubset ? { populationN: all.length } : {}),
		notCovered: isSubset
			? [`countries excluded: ${[...new Set(all.map((r) => r.country))].filter((c) => c !== ref.country).join(", ")}`]
			: [],
		hasTruth: { components: inputs.length, coordinates: 0, tier: 0, any: inputs.length, none: 0 },
		notes: [
			`Parity corpus, ${all.length} live fixtures (${tombstones} tombstones skipped)${isSubset ? `, filtered to ${inputs.length}` : ""}.`,
			"Component expectations only — NO coordinates, so a cross-engine distance comparison cannot be graded on it.",
		],
	}
}

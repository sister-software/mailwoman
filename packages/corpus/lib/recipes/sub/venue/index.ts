/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates rows that tag venue-interior strings such as `Terminal 5` or `North Gate` as `unit` beside a `venue`,
 *   with confound rows as negatives.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { poiDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilderLike } from "path-ts"

import { recipeSourceID, type CorpusRecipe } from "#recipes/scaffold"
import { buildStreetNegatives, loadContextTuples, type StreetNegatives } from "#recipes/sub/venue/context"
import { addressGroups, type Group, type Register, renderGroups, sampleRegister } from "#recipes/sub/venue/render"
import {
	buildIdentifierModel,
	defaultLexiconPath,
	EMPTY_NAME_POOLS,
	type IdentifierModel,
	type LegPools,
	mergeNamePools,
	type PoolQuery,
	type PromotedSurface,
	promotedSurfacesFor,
	readExtractPools,
	readPOIPools,
	readSubVenueLexicon,
	rejectedPhrasesFor,
	sampleIdentifier,
	titleCase,
} from "#recipes/sub/venue/sources"
import type { LocaleBaseTuple } from "#surfaces/locale"
import type { SubVenueLexiconTable } from "#tools"
import { alignRow } from "#utils"

export * from "#recipes/sub/venue/sources"
export * from "#recipes/sub/venue/context"
export * from "#recipes/sub/venue/render"

// #region Plan

/**
 * One locale's leg of the recipe.
 *
 * `positiveShare` and `negativeShare` are relative weights that the run normalizes across legs.
 */
export interface SubVenueLeg {
	locale: string
	country: string
	/**
	 * The ISO 3166-1 alpha-2 key into the lexicon's `identifierShapes`.
	 *
	 * Gate and terminal numbering differs by country, so each leg samples identifiers from its own region.
	 */
	region: string
	/**
	 * The OSM extract filename under `--extracts-dir`.
	 *
	 * A leg without an extract draws its venue and confound pools from `poi.db`.
	 */
	extract?: string
	/**
	 * Whether this leg may use the English `<modifier> <designator>` form.
	 *
	 * The modifier list is English, so non-English legs emit only designator-plus-identifier forms.
	 */
	english: boolean
	positiveShare: number
	negativeShare: number
	/**
	 * Postcode prefixes that restrict the leg's address context.
	 *
	 * The ca-ES leg uses the prefixes of the Catalan-speaking provinces
	 * because the OpenAddresses region strings are unreliable.
	 */
	postcodePrefixes?: readonly string[]
}

/**
 * The locale legs and their shares.
 *
 * The English legs carry the largest shares because only English has the modifier form
 * and most eval confound rows are GB or US addresses.
 * The en-US leg carries the largest negative share because its confound pool is the largest.
 *
 * Japanese sub-venue rows belong to the JP corpus builder, which uses a different label set.
 */
export const SUBVENUE_LEGS: readonly SubVenueLeg[] = [
	{
		locale: "en-GB",
		country: "GB",
		region: "GB",
		extract: "great-britain.jsonl",
		english: true,
		positiveShare: 0.25,
		negativeShare: 0.3,
	},
	{ locale: "en-US", country: "US", region: "GB", english: true, positiveShare: 0.25, negativeShare: 0.35 },
	{
		locale: "fr-FR",
		country: "FR",
		region: "FR",
		extract: "france.jsonl",
		english: false,
		positiveShare: 0.16,
		negativeShare: 0.2,
	},
	{
		locale: "de-DE",
		country: "DE",
		region: "DE",
		extract: "germany.jsonl",
		english: false,
		positiveShare: 0.14,
		negativeShare: 0.1,
	},
	{
		locale: "es-ES",
		country: "ES",
		region: "ES",
		extract: "spain.jsonl",
		english: false,
		positiveShare: 0.15,
		negativeShare: 0.05,
	},
	{
		locale: "ca-ES",
		country: "ES",
		region: "ES",
		extract: "spain.jsonl",
		english: false,
		positiveShare: 0.05,
		negativeShare: 0,
		postcodePrefixes: ["07", "08", "17", "25", "43"],
	},
]

/**
 * The region whose identifier distribution the en-US leg uses.
 *
 * The en-US leg has no OSM extract, and `poi.db` carries names without refs,
 * so it borrows the GB distribution.
 */
export const US_IDENTIFIER_REGION_BORROWED_FROM = "GB"

// #endregion

// #region Tunables

/**
 * The suggested `--count` for this recipe.
 *
 * The training sampler drops a source from its multinomial once the source runs out of rows,
 * so an undersized output receives less than its configured weight.
 * At a source weight of 12.0 in a one-million-row epoch, the sampler draws
 * about 77,000 rows from this output.
 * The value 120,000 leaves headroom above that.
 */
export const RECOMMENDED_ROW_COUNT = 120_000

/**
 * The default share of rows that are confound negatives without a `unit` span.
 *
 * The `--negative-fraction` option overrides it.
 */
const DEFAULT_NEGATIVE_FRACTION = 0.3

/**
 * The share of positives that use a real sub-venue name from an extract, such as `Pier 1`.
 *
 * The attested pool holds only a few dozen strings per leg, so a larger share would mostly repeat them.
 */
const ATTESTED_FRACTION = 0.1

/**
 * The share of synthesized English positives that use the `<modifier> <designator>` form.
 *
 * The share favours the modifier form because the model already handles
 * designator-plus-identifier strings such as `Terminal 5`.
 */
const ENGLISH_MODIFIER_FORM_FRACTION = 0.6

// #endregion

// #region Board reservation

/**
 * Lowercase surfaces from the eval board
 * in `packages/mailwoman/lib/eval-harness/fixtures/venue-structure-confounds.jsonl`.
 *
 * The recipe drops any row that contains one of these and counts it in `contaminated`.
 * The list is copied by hand because `@mailwoman/corpus` cannot read the board's fixture at run time.
 * Update it when the board changes.
 */
export const BOARD_RESERVED_SURFACES: readonly string[] = [
	// gb-street-gate
	"briggate",
	"kirkgate",
	"castlegate",
	"micklegate",
	"fishergate",
	"gallowgate",
	"cowgate",
	"canongate",
	"westgate",
	"northgate",
	// gate-house-venue
	"gate house",
	"gatehouse",
	// terminal-estate
	"terminal industrial estate",
	"terminal house",
	"ocean terminal",
	"terminal warehouse",
	// wing-name
	"wing yip",
	"wing lee",
	"bletchley park",
	// designator-as-street
	"campus drive",
	"arcade avenue",
	"concourse village",
	"building society place",
	"enclosure road",
	// modifier-designator-street
	"east gate",
	"west gate",
	"west wickham",
]

/**
 * Returns whether the row text contains any surface in {@link BOARD_RESERVED_SURFACES}.
 */
export function isBoardReserved(raw: string): boolean {
	const low = raw.toLowerCase()

	return BOARD_RESERVED_SURFACES.some((surface) => low.includes(surface))
}

// #endregion

// #endregion

// #region Positive forms

/**
 * A sub-venue string with the form and designator that produced it.
 */
export interface SubVenueForm {
	text: string
	form: "designator-identifier" | "modifier-designator" | "attested"
	designatorID: string
}

/**
 * Builds one sub-venue string for a leg, or returns `null` when it cannot.
 *
 * A promotion with `shape: "identifier-required"` always renders as `<Phrase> <identifier>`.
 * Some such phrases, such as German `Halle`, are also place names,
 * and only the identifier separates the two.
 * The guard lives here so that every caller inherits it.
 */
export function buildSubVenueForm(
	leg: SubVenueLeg,
	promoted: readonly PromotedSurface[],
	model: IdentifierModel,
	modifiers: readonly string[],
	attested: readonly string[],
	random: () => number
): SubVenueForm | null {
	if (!promoted.length) return null

	if (attested.length && random() < ATTESTED_FRACTION) {
		const text = sample(attested, random)

		return { text, form: "attested", designatorID: "attested" }
	}

	const modifierCandidates = leg.english ? promoted.filter((p) => p.modifierEligible && !p.identifierRequired) : []
	const useModifier = modifierCandidates.length > 0 && random() < ENGLISH_MODIFIER_FORM_FRACTION

	if (useModifier) {
		const promotedSurface = sample(modifierCandidates, random)
		const modifier = sample(modifiers, random)

		return {
			text: `${titleCase(modifier)} ${promotedSurface.surface}`,
			form: "modifier-designator",
			designatorID: promotedSurface.designatorID,
		}
	}

	const promotedSurface = sample(promoted, random)
	const identifier = sampleIdentifier(model, promotedSurface.designatorID, random)

	if (!identifier) return null

	return {
		text: `${promotedSurface.surface} ${identifier}`,
		form: "designator-identifier",
		designatorID: promotedSurface.designatorID,
	}
}

/**
 * An alias of {@link buildSubVenueForm}.
 *
 * @deprecated Use {@link buildSubVenueForm}.
 */
export const buildPositiveForms = buildSubVenueForm

// #endregion

// #region Negatives

/**
 * The confound classes that the recipe emits as negatives.
 */
export const NegativeClass = {
	/**
	 * A surface rejected for the locale in the venue slot, such as `Red Wing Shoes`.
	 */
	RejectedVenue: "rejected-venue",
	/**
	 * A longer proper name that contains a designator, tagged whole as `venue`,
	 * such as `Lochaline Ferry Terminal`.
	 */
	LongerName: "longer-name",
	/**
	 * A real street whose name contains a designator token, such as `Pier Road`.
	 */
	DesignatorStreet: "designator-street",
	/**
	 * A real street with the `<modifier> <designator>` shape, such as `East Gate`.
	 */
	ModifierDesignatorStreet: "modifier-designator-street",
	/**
	 * A GB single-token `-gate` street, such as `Moorgate`.
	 */
	GateSuffixStreet: "gate-suffix-street",
	/**
	 * A promoted phrase in a shape that its promotion excludes, such as `Halle Rosengarten`.
	 *
	 * See `LegPools.unpromotedShapes`.
	 */
	UnpromotedShape: "unpromoted-shape",
} as const

/**
 * One of the {@link NegativeClass} values.
 */
export type NegativeClass = (typeof NegativeClass)[keyof typeof NegativeClass]

/**
 * Returns the negative classes that have a non-empty source pool for this leg.
 *
 * The recipe skips a class without a source, and the report shows its absence.
 */
function availableNegativeClasses(pools: LegPools, streets: StreetNegatives): NegativeClass[] {
	const available: NegativeClass[] = []

	const sourced: ReadonlyArray<readonly [NegativeClass, number]> = [
		[NegativeClass.RejectedVenue, pools.rejectedVenues.length],
		[NegativeClass.LongerName, pools.longerNames.length],
		[NegativeClass.UnpromotedShape, pools.unpromotedShapes.length],
		[NegativeClass.DesignatorStreet, streets.designator.length],
		[NegativeClass.ModifierDesignatorStreet, streets.modifierDesignator.length],
		[NegativeClass.GateSuffixStreet, streets.gateSuffix.length],
	]

	for (const [negativeClass, size] of sourced) {
		if (size > 0) {
			available.push(negativeClass)
		}
	}

	return available
}

// #endregion

// #region Recipe

/**
 * Per-leg composition counts that the run prints.
 */
export interface SubVenueLegStats {
	locale: string
	positives: number
	negatives: number
	byForm: Record<string, number>
	byDesignator: Record<string, number>
	byNegativeClass: Record<string, number>
	byRegister: Record<string, number>
	poolSizes: Record<string, number>
}

const LICENSE =
	"Synthetic — OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) and Overture Places names " +
	"(CDLA-Permissive-2.0) over OpenAddresses / HM Land Registry Price Paid Data address skeletons"

const CORPUS_VERSION = "0.16.0"

const bump = (record: Record<string, number>, key: string): void => {
	record[key] = (record[key] ?? 0) + 1
}

/**
 * Run-wide state shared by the emit functions.
 */
interface EmitContext {
	write: (line: string) => void
	source: string
	random: () => number
	modifiers: readonly string[]
	designatorPhrases: readonly string[]
	counters: { emitted: number; skipped: number; contaminated: number }
}

/**
 * Renders, aligns and writes one row, and returns whether the row was written.
 *
 * The function drops rows that contain an eval-board surface or fail alignment.
 */
function emitRow(
	context: EmitContext,
	leg: SubVenueLeg,
	stats: SubVenueLegStats,
	groups: Group[],
	register: Register,
	synthMethod: string,
	disambiguator: Record<string, string>
): boolean {
	const { raw, components } = renderGroups(groups, register)

	if (isBoardReserved(raw)) {
		context.counters.contaminated++

		return false
	}

	const aligned = alignRow({
		raw,
		components,
		country: leg.country,
		locale: leg.locale,
		source: context.source,
		source_id: recipeSourceID(context.source, { ...components, ...disambiguator }),
		corpus_version: CORPUS_VERSION,
		license: LICENSE,
	})

	if (aligned.kind !== "labeled" || !aligned.row) {
		context.counters.skipped++

		return false
	}

	context.write(stringifyJSON({ ...aligned.row, synth_method: synthMethod, synth_base_id: null }))

	context.counters.emitted++
	bump(stats.byRegister, register)

	return true
}

// Both cutoffs apply to the same random draw per row.
const NO_STREET_SHARE = 0.25
const SUBVENUE_FIRST_CUTOFF = 0.55

/**
 * Emits one leg's positive rows, each with a `unit` span, a real `venue` and an address from the leg.
 */
function emitPositives(
	context: EmitContext,
	leg: SubVenueLeg,
	pools: LegPools,
	promoted: readonly PromotedSurface[],
	model: IdentifierModel,
	stats: SubVenueLegStats,
	target: number
): void {
	const { random } = context
	let produced = 0
	let guard = 0

	while (produced < target && guard++ < target * 8) {
		if (!pools.context.length || !pools.venues.length) break
		const form = buildSubVenueForm(leg, promoted, model, context.modifiers, pools.attested, random)

		if (!form) {
			context.counters.skipped++

			continue
		}

		const tuple = sample(pools.context, random)
		const venue = sample(pools.venues, random)

		// Alignment cannot place two spans when one contains the other, so the loop redraws.
		const lowVenue = venue.toLowerCase()
		const lowForm = form.text.toLowerCase()

		if (lowVenue.includes(lowForm) || lowForm.includes(lowVenue)) continue

		const register = sampleRegister(random)
		const subGroup: Group = [{ text: form.text, tag: "unit" }]
		const venueGroup: Group = [{ text: venue, tag: "venue" }]
		const r = random()
		// Some rows omit the street because venue addresses such as airport terminals often lack one.
		const body = addressGroups(leg.country, tuple, r >= NO_STREET_SHARE)

		// An empty body means that no address layout covers this country.
		if (!body.length) continue
		// Real mail uses both "Terminal 5, Heathrow" and "Heathrow, Terminal 5".
		const groups = r < SUBVENUE_FIRST_CUTOFF ? [subGroup, venueGroup, ...body] : [venueGroup, subGroup, ...body]

		const ok = emitRow(context, leg, stats, groups, register, `sub-venue:${form.form}`, {
			leg: leg.locale,
			form: form.form,
			v: String(produced),
		})

		if (!ok) continue

		produced++

		stats.positives++
		bump(stats.byForm, form.form)
		bump(stats.byDesignator, form.designatorID)
	}
}

// This share applies only to negatives drawn from the name pools.
const NEGATIVE_WITH_STREET_SHARE = 0.75

/**
 * Emits one leg's negative rows, none of which carries a `unit` span.
 */
function emitNegatives(
	context: EmitContext,
	leg: SubVenueLeg,
	pools: LegPools,
	stats: SubVenueLegStats,
	target: number
): void {
	const { random } = context
	const streets = buildStreetNegatives(pools.context, context.designatorPhrases, context.modifiers, leg.country)
	const available = availableNegativeClasses(pools, streets)
	let produced = 0
	let guard = 0

	while (produced < target && guard++ < target * 8) {
		if (!available.length || !pools.context.length) break
		const negativeClass = sample(available, random)
		const register = sampleRegister(random)
		let groups: Group[]

		if (negativeClass === NegativeClass.DesignatorStreet) {
			groups = addressGroups(leg.country, pickTuple(streets.designator, random), true)
		} else if (negativeClass === NegativeClass.ModifierDesignatorStreet) {
			groups = addressGroups(leg.country, pickTuple(streets.modifierDesignator, random), true)
		} else if (negativeClass === NegativeClass.GateSuffixStreet) {
			groups = addressGroups(leg.country, pickTuple(streets.gateSuffix, random), true)
		} else {
			const pool =
				negativeClass === NegativeClass.RejectedVenue
					? pools.rejectedVenues
					: negativeClass === NegativeClass.LongerName
						? pools.longerNames
						: pools.unpromotedShapes

			const name = sample(pool, random)
			const tuple = sample(pools.context, random)

			groups = [
				[{ text: name, tag: "venue" }],
				...addressGroups(leg.country, tuple, random() < NEGATIVE_WITH_STREET_SHARE),
			]
		}

		// The loop skips rows without an address, which occur when no layout covers the country.
		if (!groups.length || groups.every((group) => group.every((piece) => piece.tag === "venue"))) continue

		const ok = emitRow(context, leg, stats, groups, register, `sub-venue-negative:${negativeClass}`, {
			leg: leg.locale,
			negative: negativeClass,
			v: String(produced),
		})

		if (!ok) continue

		produced++

		stats.negatives++
		bump(stats.byNegativeClass, negativeClass)
	}
}

function pickTuple(pool: readonly LocaleBaseTuple[], random: () => number): LocaleBaseTuple {
	return sample(pool, random)
}

/**
 * Splits `total` across relative `shares` by the largest-remainder method, so the parts sum to `total`.
 */
export function allocate(total: number, shares: readonly number[]): number[] {
	const sum = shares.reduce((a, b) => a + b, 0)

	if (sum <= 0) return shares.map(() => 0)
	const exact = shares.map((s) => (total * s) / sum)
	const floored = exact.map((v) => Math.floor(v))
	let remainder = total - floored.reduce((a, b) => a + b, 0)
	const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).toSorted((a, b) => b.frac - a.frac)

	for (const entry of order) {
		if (remainder <= 0) break
		floored[entry.i]! += 1

		remainder--
	}

	return floored
}

/**
 * Builds one leg's name pools from its extract and `poi.db`, plus its address context.
 */
async function buildLegPools(
	leg: SubVenueLeg,
	query: PoolQuery,
	contextByCountry: ReadonlyMap<string, LocaleBaseTuple[]>,
	paths: { extractsDir: PathBuilderLike; poiDB: PathBuilderLike }
): Promise<LegPools> {
	const extractPools = leg.extract
		? await readExtractPools(`${paths.extractsDir}/${leg.extract}`, query)
		: EMPTY_NAME_POOLS

	// Only the US and FR legs have rows in poi.db.
	const poiPools =
		leg.country === "US" || leg.country === "FR" ? readPOIPools(paths.poiDB, leg.country, query) : EMPTY_NAME_POOLS

	const names = mergeNamePools(extractPools, poiPools)
	let context = contextByCountry.get(leg.country) ?? []

	if (leg.postcodePrefixes) {
		const prefixes = leg.postcodePrefixes
		const filtered = context.filter((t) => prefixes.some((p) => (t.postcode ?? "").startsWith(p)))

		// An empty filter result fails the build so that the leg never reuses the parent locale's rows.
		if (!filtered.length) {
			throw new Error(
				`${leg.locale}: no context tuples matched postcode prefixes ${prefixes.join(",")} among ${context.length} ${leg.country} rows`
			)
		}

		context = filtered
	}

	return { context, ...names }
}

function emptyStats(leg: SubVenueLeg, pools: LegPools, promotedCount: number): SubVenueLegStats {
	return {
		locale: leg.locale,
		positives: 0,
		negatives: 0,
		byForm: {},
		byDesignator: {},
		byNegativeClass: {},
		byRegister: {},
		poolSizes: {
			promoted: promotedCount,
			context: pools.context.length,
			venues: pools.venues.length,
			attested: pools.attested.length,
			rejectedVenues: pools.rejectedVenues.length,
			longerNames: pools.longerNames.length,
			unpromotedShapes: pools.unpromotedShapes.length,
		},
	}
}

/**
 * Generates sub-venue positives and confound negatives across the {@link SUBVENUE_LEGS}.
 *
 * Only (designator, locale) pairs that the promotion ledger accepted produce positives.
 * The recipe requires `--count`.
 */
export const subVenueRecipe: CorpusRecipe = {
	name: "sub-venue",
	description:
		"Venue-interior structure (#35): <sub-venue> unit + <venue> lines per promoted (designator, locale) pair, with the rejection ledger's confounds as negatives",
	mode: "generate",
	options: [
		{ flag: "--lexicon <path>", description: "sub-venue lexicon JSON (default: the committed corpus/data one)" },
		{
			flag: "--extracts-dir <dir>",
			description: "OSM sub-venue extract JSONLs (default: $MAILWOMAN_DATA_ROOT/sub-venue/extracts)",
		},
		{
			flag: "--poi-db <path>",
			description: "poi.db for the en-US / fr-FR pools (default: $MAILWOMAN_DATA_ROOT/db/poi/poi.db)",
		},
		{ flag: "--sub-venue-tuples <path>", description: "GB/US/FR address-context tuples JSONL" },
		{
			flag: "--negative-fraction <n>",
			description: `share of rows that are confound negatives (default ${DEFAULT_NEGATIVE_FRACTION})`,
		},
	],
	async run(opts, write) {
		if (opts.count == null) throw new Error("sub-venue recipe requires --count <N>")
		const count = opts.count
		const negativeFraction = opts.negativeFraction ?? DEFAULT_NEGATIVE_FRACTION
		const extractsDir = opts.extractsDir ?? dataRootPath("sub-venue", "extracts")
		const poiDB = opts.poiDB ?? poiDatabasePath("poi.db")
		const tuplesPath = opts.subVenueTuples ?? dataRootPath("corpus", "intermediate", "house-venue-tuples-v3.jsonl")
		const lexicon: SubVenueLexiconTable = await readSubVenueLexicon(opts.lexicon ?? defaultLexiconPath())

		const context: EmitContext = {
			write,
			source: opts.sourceName ?? "synth-sub-venue",
			random: makeMulberry32(opts.seed),
			modifiers: lexicon.modifiers.filter((m) => m.shipped).map((m) => m.id),
			designatorPhrases: lexicon.designators.filter((d) => d.tier === "subvenue").map((d) => d.id),
			counters: { emitted: 0, skipped: 0, contaminated: 0 },
		}

		console.error(`  reading context tuples: ${tuplesPath}`)

		const contextByCountry = await loadContextTuples(tuplesPath, opts.seed)
		const legPools = new Map<string, LegPools>()
		const legStats = new Map<string, SubVenueLegStats>()
		const legPromoted = new Map<string, PromotedSurface[]>()

		for (const leg of SUBVENUE_LEGS) {
			const promoted = promotedSurfacesFor(leg.locale, lexicon)

			const query: PoolQuery = {
				promoted,
				rejectedPhrases: rejectedPhrasesFor(leg.locale),
				designatorPhrases: context.designatorPhrases,
				modifiers: context.modifiers,
				english: leg.english,
			}

			const pools = await buildLegPools(leg, query, contextByCountry, { extractsDir, poiDB })

			legPromoted.set(leg.locale, promoted)
			legPools.set(leg.locale, pools)
			legStats.set(leg.locale, emptyStats(leg, pools, promoted.length))
		}

		const positiveTotal = Math.round(count * (1 - negativeFraction))

		const positiveQuota = allocate(
			positiveTotal,
			SUBVENUE_LEGS.map((l) => l.positiveShare)
		)

		const negativeQuota = allocate(
			count - positiveTotal,
			SUBVENUE_LEGS.map((l) => l.negativeShare)
		)

		for (const [index, leg] of SUBVENUE_LEGS.entries()) {
			const pools = legPools.get(leg.locale)!
			const stats = legStats.get(leg.locale)!
			const promoted = legPromoted.get(leg.locale)!
			const model = buildIdentifierModel(lexicon, leg.region)

			emitPositives(context, leg, pools, promoted, model, stats, positiveQuota[index]!)
			emitNegatives(context, leg, pools, stats, negativeQuota[index]!)
		}

		for (const stats of legStats.values()) {
			console.error(
				`  ${stats.locale}: +${stats.positives} positives / -${stats.negatives} negatives ` +
					`forms=${stringifyJSON(stats.byForm)} designators=${stringifyJSON(stats.byDesignator)} ` +
					`negclasses=${stringifyJSON(stats.byNegativeClass)} registers=${stringifyJSON(stats.byRegister)} ` +
					`pools=${stringifyJSON(stats.poolSizes)}`
			)
		}

		return { read: count, ...context.counters }
	},
}

// #endregion

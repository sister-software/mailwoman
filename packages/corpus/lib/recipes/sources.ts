/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `source` identifiers that recipe outputs write, under their retired and current spellings.
 *
 *   A recipe-output `source` is a wire identifier rather than prose. It is the literal value of the `source` column on
 *   every row of every built corpus, the key a training config's `source_weights`, `source_reps`,
 *   `augment_exclude_sources` and `required_corpus_receipts[].source` address this value. `overlay-manifest` records
 *   the `--source` label per file. Published model cards also quote the string. A rename requires a data migration
 *   across every corpus that stores it. This table retains both spellings while an archived corpus or historical
 *   config records the older one.
 *
 *   The retired spelling is `synth-<tail>`. It was read as "synthetic", and most of the rows it labels are real
 *   published records written in a layout: `synth-german` stores `register: openaddresses` and `surface: composed`.
 *   The current spelling is `<operation>-<tail>`, where the operation states what the recipe did to attested data.
 *   The tail is kept byte-for-byte, so the mapping is a prefix swap in either direction.
 *
 *   The prefix states the recipe's operation. That value stays constant per source. It omits `surface`, a row property that
 *   varies within a source. It also omits the register because `requireRegister` makes that an invocation property.
 *
 *   Every recipe reads its default `source` from this table through {@linkcode defaultRecipeSource}, and
 *   {@linkcode WRITE_CURRENT_SOURCE_NAMES} decides which spelling it answers with. An assembly rewrites its routed
 *   overlays through this table before `overlay-manifest` runs, so the rows and the recipe defaults move together.
 */

/**
 * What a recipe did to attested data to produce its rows.
 *
 * This describes the operation behind a source's id.
 * The row's `surface` is a separate field that `SurfaceOrigin` in `#types` records,
 * and the two spell `rendered` for different classifications.
 *
 * A `rendered-*` source records `SurfaceOrigin.Composed`, because `renderLocaleRow` draws
 * on the row's house number and postcode and takes an order, so it varies the written form
 * rather than writing one canonical form per record.
 * `SurfaceOrigin.Rendered` belongs to an adapter that writes that one form.
 */
export const SourceOperation = {
	/**
	 * One real record, written in a layout its country uses, with the form varied across rows.
	 */
	Rendered: "rendered",
	/**
	 * Part of one real record.
	 */
	Fragment: "fragment",
	/**
	 * A real record with a drawn component added.
	 */
	Spliced: "spliced",
	/**
	 * No real record behind the row.
	 */
	Invented: "invented",
	/**
	 * A string copied verbatim from `@mailwoman/codex`.
	 */
	Codex: "codex",
	/**
	 * Rows a person wrote and checked.
	 */
	Reviewed: "reviewed",
} as const

/**
 * One of the {@link SourceOperation} values.
 */
export type SourceOperation = (typeof SourceOperation)[keyof typeof SourceOperation]

/**
 * One recipe-output source under both spellings.
 */
export interface RecipeSource {
	/**
	 * The spelling recipes wrote through 2026-09-26.
	 *
	 * Every corpus assembled before that date stores this spelling.
	 */
	retired: string
	/**
	 * The spelling a corpus assembled after the rewrite stores and a training config keys on.
	 */
	current: string
	operation: SourceOperation
	/**
	 * The file that writes the rows, relative to `packages/corpus/lib/`
	 * unless the value specifies another root.
	 */
	producer: string
	/**
	 * Why the producer's path does not fully explain the placement.
	 */
	note?: string
}

/**
 * Builds the entries of one operation, so each line below reads as `retired tail → producer`.
 */
function entries(
	operation: SourceOperation,
	prefix: string,
	rows: ReadonlyArray<readonly [tail: string, producer: string, note?: string]>
): RecipeSource[] {
	return rows.map(([tail, producer, note]) => ({
		retired: `synth-${tail}`,
		current: `${prefix}-${tail}`,
		operation,
		producer,
		...(note ? { note } : {}),
	}))
}

const LOCALE_RECIPE = "international/recipes/locale.ts"
const TRAILING_REGION = "recipes/trailing-region.ts"

/**
 * Every recipe-output source that a corpus on disk, a training config
 * or a recipe default has spelled `synth-*`.
 *
 * Measured on 2026-09-26 over `/mnt/mw/corpus/versioned/`: 46 values on disk,
 * 47 keys across 226 configs and the recipe defaults.
 * This list is their union.
 */
export const RECIPE_SOURCES: ReadonlyArray<RecipeSource> = [
	...entries(SourceOperation.Rendered, "rendered", [
		["fr", LOCALE_RECIPE],
		["nl", LOCALE_RECIPE],
		["it", LOCALE_RECIPE],
		["pt", LOCALE_RECIPE],
		["ch", LOCALE_RECIPE],
		["hr", LOCALE_RECIPE],
		["sk", LOCALE_RECIPE],
		["lu", LOCALE_RECIPE],
		["es", LOCALE_RECIPE],
		["es-pedania", LOCALE_RECIPE, "The ES source run with `--district-as-locality`, under `--source-name`."],
		["nz", LOCALE_RECIPE],
		["gb", LOCALE_RECIPE],
		["fr-order", "fr/recipes/order.ts"],
		["fr-admin-split", "fr/recipes/admin-split.ts", "The département is derived from the record's own postcode."],
		["fr-lieudit", "fr/recipes/lieudit.ts"],
		["sg-register", "sg/recipes/register.ts"],
		["pk-register", "south-asia/recipes/register.ts"],
		["bd-register", "south-asia/recipes/register.ts"],
		["cz-pcfirst-preposition", "cz/recipes/pcfirst-preposition.ts"],
		["cz-pcfirst-preposition-v20", "cz/recipes/pcfirst-preposition.ts"],
		["cz-pcfirst-preposition-v21", "cz/recipes/pcfirst-preposition.ts"],
		["no-street-led", "no/recipes/street/led.ts"],
		["si-bare-village", "si/recipes/bare-village.ts"],
		["nl-postcode", "nl/recipes/postcode.ts"],
	]),
	// Germany is the one locale the retired names spelled as a language word
	// where every other reads as an ISO code, so its tail becomes `de`.
	// Its producer already sits in `de/recipes/`, and a reader comparing `rendered-de`
	// against `rendered-fr` and `rendered-es` sees one shape for all three.
	//
	// The table keeps every other tail byte-for-byte, so three conventions for where a locale sits in a
	// tail survive: the locale by itself (`rendered-fr`), the locale first (`invented-no-street`).
	// The locale comes last (`spliced-trailing-region-us`).
	// A second migration over the rows each entry names would be required to normalize those tails.
	// This migration preserves them.
	{
		retired: "synth-german",
		current: "rendered-de",
		operation: SourceOperation.Rendered,
		producer: "de/recipes/locale.ts",
	},
	// Three tails include the word `fragment` themselves.
	// It folds into the prefix instead of repeating.
	{
		retired: "synth-fragment",
		current: "fragment-assay",
		operation: SourceOperation.Fragment,
		producer: "corpus-python/src/mailwoman_train/corpora/fragment/build.py",
		note:
			"The rows carry `recipe: fragment-assay`, and no registered recipe emits this source: the producer " +
			"named above is out of the tree, so the rows cannot be rebuilt. 4,765 of the 200,348 on disk carry " +
			"`country: ZZ`, of which the candidate gazetteer resolves 3,115 to one country and 1,650 to none or " +
			"several (measured 2026-09-28). The source survives that decision, so the name is settled (#2358).",
	},
	{
		retired: "synth-fr-fragment",
		current: "fragment-fr",
		operation: SourceOperation.Fragment,
		producer: "fr/recipes/fragment.ts",
	},
	{
		retired: "synth-no-fragment",
		current: "fragment-no",
		operation: SourceOperation.Fragment,
		producer: "no/recipes/fragment.ts",
	},
	...entries(SourceOperation.Fragment, "fragment", [
		["fr-bare-street", "fr/recipes/bare-street.ts"],
		["fr-bare-street-v20", "fr/recipes/bare-street.ts"],
		["fr-bare-street-v21", "fr/recipes/bare-street.ts"],
		["fr-bare-street-v22", "fr/recipes/bare-street.ts"],
	]),
	...entries(SourceOperation.Spliced, "spliced", [
		["unit", "recipes/unit.ts", "The unit designator and number are drawn."],
		["unit-v30", "recipes/unit.ts"],
		["affix", "recipes/street/affix.ts"],
		["suffix-boundary", "recipes/street/affix.ts"],
		["country", "recipes/country-balanced.ts", "Country names are drawn without regard to the address's own country."],
		["sub-venue", "recipes/sub/venue/index.ts"],
		["trailing-region", TRAILING_REGION, "The house number is drawn on a quarter of the postcode rows."],
		["trailing-region-structured", TRAILING_REGION],
		["trailing-region-us", TRAILING_REGION],
		["trailing-region-ca-bare", TRAILING_REGION],
		["trailing-region-es-v23", TRAILING_REGION],
		["trailing-region-gb-v23", TRAILING_REGION],
		["trailing-region-es-v28", TRAILING_REGION],
	]),
	...entries(SourceOperation.Invented, "invented", [
		["po-box", "recipes/po/box/index.ts"],
		["po-box-cedex", "recipes/po/box/cedex/recipe.ts"],
		["po-box-military", "recipes/po/box/index.ts"],
		["intersection", "recipes/intersection.ts"],
		["anchor-absorption", "recipes/anchor-absorption.ts"],
		["boundary-stress", "recipes/boundary-stress.ts"],
		["street", "recipes/street.ts"],
		[
			"street-bare",
			"recipes/street/bare.ts",
			"`synthesizeStreetRow` composes the street from `STREET_NAMES`, `DIRECTIONAL_PREFIXES` and " +
				"`STREET_SUFFIXES`, all hand-written word lists, over the hand-written `DEFAULT_US_BASES` city " +
				"tuples. No register supplies any part of the row, so the operation is invented rather than composed.",
		],
		["no-street", "no/recipes/street/index.ts"],
		["no-street-v063", "no/recipes/street/index.ts"],
		["house-venue", "recipes/house-venue.ts"],
		["house-venue-v063", "recipes/house-venue.ts"],
	]),
	...entries(SourceOperation.Codex, "codex", [
		["bare-postcode", "recipes/bare/postcode/index.ts"],
		["bare-country", "recipes/bare/country.ts"],
		["bare-country-v23", "recipes/bare/country.ts"],
	]),
	{
		retired: "synth-reviewed-postcode-tail",
		current: "reviewed-postcode-tail",
		operation: SourceOperation.Reviewed,
		producer: "ve/recipes/reviewed-postcode-tail.ts",
		note: "The tail's own `reviewed` folds into the prefix.",
	},
]

/**
 * Overlay sources that are not recipe outputs and keep their spelling.
 *
 * Each is either a register's own name, used by an adapter or builder that reads that
 * register by construction, or an adversarial set whose producer chose the name.
 * They are listed so a check over training configs can tell a source that
 * exists from one that a sweep invented.
 */
export const CARRIED_SOURCES: ReadonlyArray<string> = [
	"overture",
	"overture-latam",
	"gnaf",
	"osm",
	"deepseek-kryptonite",
	"deepseek-translit-cyrl",
	"deepseek-translit-jpan",
	"deepseek-translit-hans",
	"deepseek-translit-hang",
	"deepseek-translit-armn",
	"synthetic-secondary",
	"overture-jp",
	"houjin-jp",
	"juso-kr",
	"localdata-kr",
	"overture-tw",
	"gcis-tw",
	"coarse-placer-cn-units",
	// A 2026-07 overlay weighted by `v1.9.6-slavic-anchor.yaml` and `v1.9.7-bsplice.yaml`.
	// The producer's code is absent from the tree.
	// The two configs record its runs.
	"oa-slavic",
]

const BY_RETIRED = new Map(RECIPE_SOURCES.map((entry) => [entry.retired, entry]))
const BY_CURRENT = new Map(RECIPE_SOURCES.map((entry) => [entry.current, entry]))

/**
 * The current spelling of a recipe-output source given either spelling,
 * or `null` for a source this table does not record.
 *
 * A caller rewriting a corpus must refuse on `null` rather than pass the value through, because a
 * pass-through leaves a corpus carrying two vocabularies with no record of which files were touched.
 */
export function currentSourceName(source: string): string | null {
	return BY_RETIRED.get(source)?.current ?? BY_CURRENT.get(source)?.current ?? null
}

/**
 * The table entry a source belongs to, under either spelling.
 */
export function recipeSource(source: string): RecipeSource | null {
	return BY_RETIRED.get(source) ?? BY_CURRENT.get(source) ?? null
}

/**
 * The spelling a recipe writes today, given the retired spelling it has always written.
 *
 * Every recipe's default `source` reads this rather than holding a literal, so the
 * vocabulary is one constant rather than 26 files. {@linkcode WRITE_CURRENT_SOURCE_NAMES}
 * decides which spelling it answers with.
 * It must agree with the corpus that a recipe output joins.
 *
 * @throws When the table records no entry for `retired`.
 * A pass-through would let a typo become a source ID on every row of a built corpus.
 * `wire-identifiers` catches that failure later.
 * This function catches it at the call.
 */
export function defaultRecipeSource(retired: string): string {
	const entry = BY_RETIRED.get(retired)

	if (!entry) {
		throw new Error(
			`RECIPE_SOURCES records no source ${retired}. A recipe's default \`source\` is a wire identifier ` +
				`stored on every row it writes, so add the entry with its operation and producer before writing it.`
		)
	}

	return WRITE_CURRENT_SOURCE_NAMES ? entry.current : entry.retired
}

/**
 * Whether a recipe writes the operation spelling or the retired one.
 *
 * True since 2026-09-28, because the rewrite has run.
 * `v0.7.0-overlay-staging` records 43 distinct sources, each under an operation prefix.
 *
 * Its `source-names.json` records the mapping applied per file with the row count
 * and the ordered-`source_id` digest verified on both sides.
 * `v0.7.0-de-holdout/corpus-v0.7.0-de-holdout` is assembled from those bytes over 766 slices.
 *
 * A recipe writing the retired spelling from here on would produce an output
 * disagreeing with the corpus it joins.
 *
 * `v0.6.0-register-surface` and the staging directory's `.pre-rename` copy are never rewritten in place.
 * The configs that target them keep the spelling their corpus stores.
 */
export const WRITE_CURRENT_SOURCE_NAMES = true

/**
 * The retired spelling of a recipe-output source given either spelling, or the value unchanged.
 *
 * `RECIPE_SURFACES` and `OVERLAY_REGISTERS` key on the retired spelling.
 * Both refuse a source they do not record.
 *
 * A corpus rewritten to the current spelling would therefore make each of them
 * throw on every row in the corpus.
 *
 * Callers of those two tables resolve the key through this, so a lookup answers under
 * either spelling and a genuinely unknown source still refuses.
 *
 * The value is returned unchanged for a source outside the table — an adapter id,
 * or an overlay source id — because those tables are keyed by whatever the producer emits.
 */
export function retiredSourceName(source: string): string {
	return BY_CURRENT.get(source)?.retired ?? source
}

/**
 * Every recipe-output spelling and adapter source id this table knows.
 *
 * Adapter ids are not here.
 * They are declared by each adapter as `<NAME>_ADAPTER_ID`, and a reader that needs
 * the full set of stored `source` values joins the two.
 */
export function knownOverlaySourceNames(): ReadonlySet<string> {
	return new Set([...BY_RETIRED.keys(), ...BY_CURRENT.keys(), ...CARRIED_SOURCES])
}

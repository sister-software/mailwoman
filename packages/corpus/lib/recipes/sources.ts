/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `source` identifiers that recipe outputs carry, under their retired and current spellings.
 *
 *   A recipe-output `source` is a wire identifier rather than prose. It is the literal value of the `source` column on
 *   every row of every built corpus, the key a training config's `source_weights`, `source_reps`,
 *   `augment_exclude_sources` and `required_corpus_receipts[].source` address, the `--source` label `overlay-manifest`
 *   records per file, and the string a published model card quotes. Renaming one is a data migration over every
 *   corpus that stores it, which is why both spellings stay in this table for as long as an archived corpus or a
 *   historical config carries the older one.
 *
 *   The retired spelling is `synth-<tail>`. It was read as "synthetic", and most of the rows it labels are real
 *   published records written in a layout: `synth-german` carries `register: openaddresses` and `surface: composed`.
 *   The current spelling is `<operation>-<tail>`, where the operation states what the recipe did to attested data.
 *   The tail is kept byte-for-byte, so the mapping is a prefix swap in either direction.
 *
 *   The prefix states the recipe's operation, which is constant per source. It never restates `surface`, which is a
 *   property of the row and varies inside a source, and it never carries the register, which `requireRegister` makes
 *   a property of the invocation.
 *
 *   Recipes still stamp the retired spelling until each reads its default from this table. A corpus assembled after
 *   2026-09-26 carries the current spelling because the assembly rewrites the routed overlays through this table
 *   before `overlay-manifest` runs.
 */

/**
 * What a recipe did to attested data to produce its rows.
 */
export const SourceOperation = {
	/**
	 * One real record, written in a layout its country uses.
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
	 * The spelling recipes wrote through 2026-09-26, which every corpus assembled before then stores.
	 */
	retired: string
	/**
	 * The spelling a corpus assembled after the rewrite stores and a training config keys on.
	 */
	current: string
	operation: SourceOperation
	/**
	 * The file that writes the rows, relative to `packages/corpus/lib/` unless it says otherwise.
	 */
	producer: string
	/**
	 * Why the placement is what it is, where the producer alone does not settle it.
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
 * 47 keys across 226 configs, and the defaults in the recipes.
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
	// The table keeps every other tail byte-for-byte, so three conventions for
	// where a locale sits in a tail survive: the locale alone (`rendered-fr`), the locale
	// first (`invented-no-street`), and the locale last (`spliced-trailing-region-us`).
	// Normalizing those is a second migration over the rows each one names, and it is not this one.
	{
		retired: "synth-german",
		current: "rendered-de",
		operation: SourceOperation.Rendered,
		producer: "de/recipes/locale.ts",
	},
	// Three tails carry the word `fragment` themselves, and it folds into the prefix rather than repeating.
	{
		retired: "synth-fragment",
		current: "fragment-assay",
		operation: SourceOperation.Fragment,
		producer: "corpus-python/src/mailwoman_train/corpora/fragment/build.py",
		note: "The rows carry `recipe: fragment-assay`. 4,765 of the 200,348 on disk carry `country: ZZ` (#2358).",
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
			"Provisional. The header says the rows come from the built-in `DEFAULT_US_BASES` pool, and the provenance block declares `Composed` behind `requireRegister`; the file decides which.",
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
 * Each is either a register's own name, carried by an adapter or a builder that reads one
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
	// A 2026-07 overlay that `v1.9.6-slavic-anchor.yaml` and `v1.9.7-bsplice.yaml` weight.
	// Its producer is not in the tree, and the two configs are records of runs.
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
 * Every recipe-output and carried source spelling this table knows.
 *
 * Adapter ids are not here.
 * They are declared by each adapter as `<NAME>_ADAPTER_ID`, and a reader that needs
 * the full set of stored `source` values joins the two.
 */
export function knownOverlaySourceNames(): ReadonlySet<string> {
	return new Set([...BY_RETIRED.keys(), ...BY_CURRENT.keys(), ...CARRIED_SOURCES])
}

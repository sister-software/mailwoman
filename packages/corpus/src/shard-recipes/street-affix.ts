/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `street-affix` shard recipe — the US street-affix coverage shard (the v0-parity `street_prefix` /
 *   `street_suffix` gap — both ~0% F1 in the #15 assessment, collapsed into `street`). Raises
 *   PREVALENCE of affix-split streets with format diversity so the model learns to split "N Main
 *   St" → street_prefix="N" + street="Main" + street_suffix="St", and (negative space) sharpens
 *   `street` itself. Ported from scripts/build-street-affix-shard.mjs.
 *
 *   Reads REAL US OpenAddresses tuples and SPLITS the OA `street` field via the codex:
 *   `matchLeadingDirectional` (USPS Pub-28 C1) for the prefix, `matchTrailingSuffix` (Pub-28 C2
 *   street suffixes) for the suffix. OA streets nearly all carry a suffix; only ~10-20% carry a
 *   directional, so we INJECT a directional prefix onto a fraction of prefix-less streets to give
 *   `street_prefix` real signal. Each row varies surface form per affix — abbreviated ("N", "St")
 *   vs expanded ("North", "Street") — and varies the layout (full address / bare / street-only /
 *   venue-prefixed).
 *
 *   LEAKAGE-SAFE EVAL (`--golden`): held-out eval uses the VERMONT source only (the corpus
 *   defaultHoldout), a different seed, and emits {raw, components} for per-locale-f1. Train uses
 *   every NON-Vermont US source.
 *
 *   Multi-locale BALANCE (`--multilocale-count`, opts.multilocaleCount > 0): appends NO-affix
 *   native-order rows (FR/DE/IT/NL) AFTER the US affix rows, riding the same source weight, purely
 *   to keep the postcode-ORDER distribution multi-locale so a US-heavy affix shard doesn't dilute
 *   FR/DE postcode (the v0.9.8 blemish).
 */

import {
	DirectionalAbbreviation,
	lookupDirectional,
	matchCase,
	matchLeadingDirectional,
	matchTrailingSuffix,
	renderDirectional,
	US_STREET_SUFFIX_PREFERRED_ABBR,
} from "@mailwoman/codex/us"
import type { ComponentTag } from "@mailwoman/core/types"
import { dataRootPath } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { stableSourceID } from "#adapters/utils"
import { NAME_PRONE_US_SUFFIXES } from "#name-prone-us-suffixes"
import {
	makeMulberry32,
	readCSVRecords,
	readZippedCSVRecords,
	shardSourceID,
	type ShardRecipe,
} from "#shard-recipes/scaffold"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

// Same OA cache as the unit shard. Train = every NON-Vermont state; eval = Vermont (the holdout).

interface USSource {
	zip: PathBuilderLike
	csv: string
	region: string
}

const TRAIN_SOURCES: readonly USSource[] = [
	{ zip: dataRootPath("oa-cache", "us__ca__berkeley.zip"), csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__ca__marin.zip"), csv: "us/ca/marin.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__dc__statewide.zip"), csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: dataRootPath("oa-cache", "us__ia__statewide.zip"), csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: dataRootPath("oa-cache", "us__il__cook.zip"), csv: "us/il/cook.csv", region: "IL" },
	{ zip: dataRootPath("oa-cache", "us__mt__statewide.zip"), csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: dataRootPath("oa-cache", "us__sd__statewide.zip"), csv: "us/sd/statewide.csv", region: "SD" },
]

const EVAL_SOURCE: USSource = {
	zip: dataRootPath("oa-cache", "us__vt__statewide.zip"),
	csv: "us/vt/statewide.csv",
	region: "VT",
}

// Multi-locale BALANCE sources (--multilocale-count > 0). These rows carry NO affix split — they exist
// only to keep the postcode-ORDER distribution multi-locale. Native-order rendering mirrors
// build-country-shard-balanced.mjs: FR = number-street, postcode-city; DE/IT/NL = street-number,
// postcode-city. `order` drives the body.
interface BalanceSource {
	zip: PathBuilderLike
	csv: string
	iso2: string
	region: string
	order: string
}

const MULTILOCALE_SOURCES: readonly BalanceSource[] = [
	{
		zip: dataRootPath("oa-cache", "de__sn__statewide.zip"),
		csv: "de/sn/statewide.csv",
		iso2: "DE",
		region: "",
		order: "eu",
	},
	{
		zip: dataRootPath("oa-cache", "fr__countrywide.zip"),
		csv: "fr/countrywide.csv",
		iso2: "FR",
		region: "",
		order: "fr",
	},
	{
		zip: dataRootPath("oa-cache", "it__countrywide.zip"),
		csv: "it/countrywide.csv",
		iso2: "IT",
		region: "",
		order: "eu",
	},
	{
		zip: dataRootPath("oa-cache", "nl__countrywide.zip"),
		csv: "nl/countrywide.csv",
		iso2: "NL",
		region: "",
		order: "eu",
	},
]

const MULTILOCALE_EVAL_SOURCES: readonly BalanceSource[] = [
	{ zip: dataRootPath("oa-cache", "de__berlin.zip"), csv: "de/berlin.csv", iso2: "DE", region: "", order: "eu" },
]

/**
 * ["N","E","S","W","NE","NW","SE","SW"].
 */
const DIRECTIONAL_ABBRS = Object.values(DirectionalAbbreviation)
/**
 * Fraction of prefix-less streets that get a synthetic directional.
 */
const INJECT_PREFIX_PROB = 0.3

/**
 * A real US skeleton tuple read from a cached OA zip.
 */
interface USTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	base_source_id: string
}

/**
 * A non-US BALANCE tuple (carries a postcode + native order).
 */
interface BalanceTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	iso2: string
	order: string
}

/**
 * Prefix carried through render — the (canonical, abbreviation) pair `renderDirectional` consumes.
 */
type Prefix = Pick<NonNullable<ReturnType<typeof matchLeadingDirectional>>, "canonical" | "abbreviation">

/**
 * Stream real US tuples (number/street/city/postcode) out of a cached OA zip.
 */
async function readTuples(source: USSource): Promise<USTuple[]> {
	const tuples: USTuple[] = []
	const seen = new Set<string>()

	for await (const row of readZippedCSVRecords(source.zip, source.csv)) {
		const street = row.street ?? ""
		const locality = row.city ?? ""
		const house_number = row.number ?? ""

		if (!street || !locality || !house_number) continue
		const key = `${house_number}|${street}|${locality}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)

		tuples.push({
			house_number,
			street,
			locality,
			region: source.region,
			postcode: row.postcode ?? "",
			base_source_id: `openaddresses:${source.csv}:${key}`,
		})
	}

	return tuples
}

const title = (s: string): string =>
	s
		.toLowerCase()
		.split(/\s+/)
		.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ")

const isSuffixOrDirectional = (word: string): boolean =>
	matchTrailingSuffix(word) !== null || matchLeadingDirectional(word) !== null

/**
 * Split an OA street into { prefix?, name, suffix } using the codex. Requires a trailing suffix and a non-empty name
 * that isn't itself an affix token. Returns null when the street has no usable suffix.
 */
function parseStreet(
	street: string,
	opts: { allowNameProneTail?: boolean } = {}
): { prefix: Prefix | null; name: string; suffix: string } | null {
	let words = street.trim().split(/\s+/)

	if (words.length < 2) return null
	let prefix: Prefix | null = null
	// Leading directional — only if it leaves ≥2 words behind (room for a name + suffix).
	const lead = matchLeadingDirectional(street)

	if (lead && words.length > 2) {
		prefix = { canonical: lead.canonical, abbreviation: lead.abbreviation }
		words = words.slice(1)
	}

	// Trailing USPS suffix — only if it leaves ≥1 word for the name.
	const trail = matchTrailingSuffix(words.join(" "))

	if (!trail || words.length < 2) return null
	const suffix = trail.canonical
	const name = words.slice(0, -1).join(" ")

	if (!name) return null

	if (isSuffixOrDirectional(name)) {
		const nameTail = matchTrailingSuffix(name)

		if (!opts.allowNameProneTail || !nameTail || !NAME_PRONE_US_SUFFIXES.has(nameTail.canonical)) return null
	}

	return { prefix, name, suffix }
}

export type SuffixBoundaryClass = "terminal-only" | "terminal-contrast"

// A terminal-only surface needs a name word before the penultimate suffix (`Blue Hill Rd`): three words at least.
const TERMINAL_ONLY_MIN_WORDS = 3

/**
 * Classify a real street surface for #1569. `terminal-only` has an ambiguous suffix-eligible name word immediately
 * before a different terminal type (`Blue Hill Rd`); `terminal-contrast` ends at the ambiguous word itself (`Sutton
 * Hollow`). The contrast check intentionally wins when both final words are name-prone: only the LAST token is the
 * suffix under the canonical rule.
 */
export function classifySuffixBoundaryStreet(street: string): SuffixBoundaryClass | null {
	const words = street.trim().split(/\s+/)

	if (words.length < 2) return null
	const terminal = matchTrailingSuffix(words.at(-1)!)

	if (!terminal) return null

	if (NAME_PRONE_US_SUFFIXES.has(terminal.canonical)) return "terminal-contrast"

	if (words.length < TERMINAL_ONLY_MIN_WORDS) return null

	const penultimate = matchTrailingSuffix(words.at(-2)!)

	return penultimate && NAME_PRONE_US_SUFFIXES.has(penultimate.canonical) ? "terminal-only" : null
}

/**
 * Render the affix-split street in random surface forms (abbrev vs expanded per affix), Title-cased.
 */
function renderStreet(
	random: () => number,
	parsed: { prefix: Prefix | null; name: string; suffix: string }
): { street: string; components: Partial<Record<ComponentTag, string>> } {
	const name = title(parsed.name)
	const parts: string[] = []
	const components: Partial<Record<ComponentTag, string>> = { street: name }

	// Prefix: natural (from parse) or injected onto a prefix-less street to boost street_prefix signal.
	let prefix = parsed.prefix

	if (!prefix && random() < INJECT_PREFIX_PROB) {
		const m = lookupDirectional(DIRECTIONAL_ABBRS[Math.floor(random() * DIRECTIONAL_ABBRS.length)])!
		prefix = { canonical: m.directional, abbreviation: m.abbreviation }
	}

	if (prefix) {
		const rendered = renderDirectional(prefix, random() < 0.5 ? "abbr" : "full", "Aa") // "Aa" → Title-case
		components.street_prefix = rendered
		parts.push(rendered)
	}

	parts.push(name)

	// Suffix: abbreviated ("St") vs expanded ("Street"), Title-cased to match the name.
	const full = title(parsed.suffix)

	// canonical is uppercase word → "Street"
	const abbr = matchCase(
		US_STREET_SUFFIX_PREFERRED_ABBR[parsed.suffix as keyof typeof US_STREET_SUFFIX_PREFERRED_ABBR],
		"Aa"
	)

	// "AVE" → "Ave"
	const renderedSuffix = random() < 0.5 ? abbr : full
	components.street_suffix = renderedSuffix
	parts.push(renderedSuffix)

	return { street: parts.join(" "), components }
}

/**
 * Synthetic recipient/venue prefixes — the arena's "JOHN DOE, ACME INC, …" pattern.
 */
const VENUES = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]

/**
 * Real-venue pool for the suffix-boundary v2 venue shell (corpus 0.19.0). The 2026-08-10 recipe review found the
 * v0.18.x shard's venue-led rows detectable as templates (six fixed venue strings), and the frozen B1 board's failures
 * concentrate in exactly that shell (rich rows 5/43 vs bare 53/65 at v4.3.3 step-40k). HRSA's health-center site file
 * supplies thousands of REAL US facility names ('Alburg Health Center'-register), US-government public domain, already
 * a corpus source (`usgov-hrsa-fqhc`). Kept verbatim (including the ~11% all-caps names — real register diversity);
 * comma-carrying names are dropped because the venue layout uses commas as its field delimiter.
 */
const VENUE_POOL_CSV = dataRootPath(
	"corpus",
	"sources",
	"usgov-hrsa-fqhc",
	"Health_Center_Service_Delivery_and_LookAlike_Sites.csv"
)

// Facility-name length window: shorter reads as an initialism, longer as a sentence.
const VENUE_NAME_MIN_LENGTH = 3
const VENUE_NAME_MAX_LENGTH = 60

async function readVenuePool(csvPath: PathBuilderLike): Promise<string[]> {
	const seen = new Set<string>()
	const pool: string[] = []

	for await (const record of readCSVRecords(csvPath)) {
		const name = (record["site name"] ?? record["Site Name"] ?? "").trim().replaceAll(/\s+/gu, " ")

		if (
			name.length < VENUE_NAME_MIN_LENGTH ||
			name.length > VENUE_NAME_MAX_LENGTH ||
			name.includes(",") ||
			!/\p{L}/u.test(name)
		)
			continue

		const key = name.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)
		pool.push(name)
	}

	return pool
}

const tail = (loc: string, reg: string, pc: string): string => (pc ? `${loc}, ${reg} ${pc}` : `${loc}, ${reg}`)

/**
 * Layout-shell options for {@link renderRow}. `cuts` are the cumulative random() cutoffs for [full, bare, street-only] —
 * the remainder is the venue shell. Defaults reproduce the original street-affix distribution (40/25/20/15) with the
 * six template venues.
 */
interface RenderRowOpts {
	venues?: readonly string[]
	cuts?: readonly [number, number, number]
}

/**
 * Embed the rendered street in a RANDOM layout so the model recognizes affixes wherever the street sits: full address,
 * bare house+street, street-only (pure affix parse), or venue-prefixed.
 */
export function renderRow(
	random: () => number,
	base: USTuple,
	street: string,
	streetComponents: Partial<Record<ComponentTag, string>>,
	opts: RenderRowOpts = {}
): { fmt: string; raw: string; components: Partial<Record<ComponentTag, string>> } {
	const venues = opts.venues ?? VENUES
	const [fullCut, bareCut, streetOnlyCut] = opts.cuts ?? [0.4, 0.65, 0.85]

	const hn = base.house_number,
		loc = base.locality,
		reg = base.region,
		pc = base.postcode

	const road = `${hn} ${street}`
	const withRoad: Partial<Record<ComponentTag, string>> = { house_number: hn, ...streetComponents }
	const r = random()

	if (r < fullCut)
		return {
			fmt: "full",
			raw: `${road}, ${tail(loc, reg, pc)}`,
			components: { ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
		}

	if (r < bareCut) return { fmt: "bare", raw: road, components: withRoad }

	if (r < streetOnlyCut) return { fmt: "street-only", raw: street, components: { ...streetComponents } }
	const v = venues[Math.floor(random() * venues.length)]!

	return {
		fmt: "venue",
		raw: `${v}, ${road}, ${tail(loc, reg, pc)}`,
		components: { venue: v, ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
	}
}

/**
 * Capped reader for the multi-locale BALANCE sources. The FR/IT/NL countrywide extracts are GB-scale, so this reads
 * only as far as `limit` distinct tuples — the `break` closes the reader and releases the archive. Only keeps tuples
 * that carry a POSTCODE.
 */
async function readBalanceTuples(source: BalanceSource, limit: number): Promise<BalanceTuple[]> {
	const tuples: BalanceTuple[] = []
	const seen = new Set<string>()

	for await (const row of readZippedCSVRecords(source.zip, source.csv)) {
		if (tuples.length >= limit) break

		const street = row.street ?? "",
			locality = row.city ?? "",
			house_number = row.number ?? "",
			postcode = row.postcode ?? ""

		if (!street || !locality || !house_number || !postcode) continue // postcode is required for balance
		const key = `${house_number}|${street}|${locality}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)

		tuples.push({
			house_number,
			street,
			locality,
			region: row.region || source.region,
			postcode,
			iso2: source.iso2,
			order: source.order,
		})
	}

	return tuples
}

/**
 * Render a non-US BALANCE row in native order — NO affix split, NO country token. `street` is the OA value verbatim.
 * The sole job is to put a postcode in its native position so the shard doesn't pull the model US-ward.
 */
function renderBalanceRow(t: BalanceTuple): { raw: string; components: Partial<Record<ComponentTag, string>> } {
	const { house_number: hn, street, locality: loc, postcode: pc, order } = t
	// region is intentionally omitted — it isn't rendered in `raw`, so labeling it would fail alignment.
	const components: Partial<Record<ComponentTag, string>> = { house_number: hn, street, locality: loc, postcode: pc }

	const raw =
		order === "fr"
			? `${hn} ${street}, ${pc} ${loc}` // French: number-street, postcode-city
			: `${street} ${hn}, ${pc} ${loc}`

	// DE/IT/NL: street-number, postcode-city
	return { raw, components }
}

/**
 * Shard recipe registered with the corpus builder — see the file header for the parse behaviour it exists to exercise,
 * and `description` below for the surface form it generates.
 */
export const streetAffixRecipe: ShardRecipe = {
	name: "street-affix",
	description: "US street-affix rows: OA streets split into street_prefix/street/street_suffix (+ multilocale balance)",
	mode: "generate",
	options: [
		{
			flag: "--multilocale-count <N>",
			description: "Append N no-affix native-order balance rows (FR/DE/IT/NL). Default 0",
		},
	],
	async run(opts, write) {
		// Legacy build-street-affix-shard.mjs seeded `mulberry32(opts.seed)`.
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 50_000
		const source = opts.sourceName ?? "synth-affix"
		const multilocaleCount = opts.multilocaleCount ?? 0
		const sources = opts.golden ? [EVAL_SOURCE] : TRAIN_SOURCES

		const pool: USTuple[] = []

		for (const s of sources) {
			const t = await readTuples(s)

			console.error(`  ${s.csv}: ${t.length} unique tuples`)

			for (const x of t) {
				pool.push(x)
			}
		}

		if (!pool.length) {
			throw new Error(`No US tuples found — are the cached OA zips present in ${dataRootPath("oa-cache")}?`)
		}

		let emitted = 0
		let skipped = 0
		let noAffix = 0
		let guard = 0
		const formatCounts: Record<string, number> = {}
		const affixCounts = { prefix: 0, suffix: 0, both: 0 }
		const N = pool.length

		while (emitted < count && guard++ < count * 10) {
			const base = pool[Math.floor(random() * N)]!
			const parsed = parseStreet(base.street)

			if (!parsed) {
				noAffix++

				continue
			}

			const { street, components: streetComponents } = renderStreet(random, parsed)
			const { fmt, raw, components } = renderRow(random, base, street, streetComponents)

			// Every affix surface form must survive verbatim in raw, else alignment can't label it.
			const surfaces = [streetComponents.street_prefix, streetComponents.street, streetComponents.street_suffix].filter(
				(s): s is string => Boolean(s)
			)

			if (!surfaces.every((s) => raw.includes(s))) {
				skipped++

				continue
			}

			formatCounts[fmt] = (formatCounts[fmt] ?? 0) + 1
			const hasP = !!streetComponents.street_prefix

			if (hasP && streetComponents.street_suffix) {
				affixCounts.both++
			} else if (hasP) {
				affixCounts.prefix++
			} else {
				affixCounts.suffix++
			}

			if (opts.golden) {
				write(JSON.stringify({ raw, components, country: "US" }) + "\n")

				emitted++

				continue
			}

			const canonical: CanonicalRow = {
				raw,
				components,
				country: "US",
				locale: "en-US",
				source,
				source_id: stableSourceID(source, components),
				corpus_version: "0.4.0",
				license: "OpenAddresses US (non-VT) skeletons, street split via USPS Pub-28 C1/C2 (codex)",
			}

			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(JSON.stringify({ ...aligned.row, synth_method: "affix", synth_base_id: null }) + "\n")

			emitted++
		}

		// ── Multi-locale balance rows (--multilocale-count) ─────────────────────────────────────────────
		// Appended AFTER the US affix rows so the US affix signal is unchanged (same `--count`), and the
		// non-US rows ride the SAME source weight. Native-order postcodes, no affix labels.
		let balanceEmitted = 0
		let balanceSkipped = 0
		const balanceISO: Record<string, number> = {}

		if (multilocaleCount > 0) {
			const mlSources = opts.golden ? MULTILOCALE_EVAL_SOURCES : MULTILOCALE_SOURCES
			const perSource = Math.ceil((multilocaleCount * 3) / mlSources.length) // over-read; balance locales
			const mlPool: BalanceTuple[] = []

			for (const s of mlSources) {
				const t = await readBalanceTuples(s, perSource)

				console.error(`  balance ${s.csv} (${s.iso2}): ${t.length} tuples`)

				for (const x of t) {
					mlPool.push(x)
				}
			}

			const M = mlPool.length
			let mlGuard = 0

			// oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `M > 0` is an invariant guard against an empty pool, not a progress condition
			while (M > 0 && balanceEmitted < multilocaleCount && mlGuard++ < multilocaleCount * 10) {
				const t = mlPool[Math.floor(random() * M)]!
				const { raw, components } = renderBalanceRow(t)

				// Every component surface must survive in raw, else alignment can't label it.
				if (![components.street, components.locality, components.postcode].every((s) => !!s && raw.includes(s))) {
					balanceSkipped++

					continue
				}

				balanceISO[t.iso2] = (balanceISO[t.iso2] ?? 0) + 1
				const locale = `${t.iso2.toLowerCase()}-${t.iso2}`

				if (opts.golden) {
					write(JSON.stringify({ raw, components, country: t.iso2 }) + "\n")

					balanceEmitted++

					continue
				}

				const canonical: CanonicalRow = {
					raw,
					components,
					country: t.iso2,
					locale,
					source,
					source_id: stableSourceID(source, components),
					corpus_version: "0.4.0",
					license: "OpenAddresses non-US skeletons (native-order postcode balance for the affix shard)",
				}

				const aligned = alignRow(canonical)

				if (aligned.kind !== "labeled" || !aligned.row) {
					balanceSkipped++

					continue
				}

				write(JSON.stringify({ ...aligned.row, synth_method: "affix-balance", synth_base_id: null }) + "\n")

				balanceEmitted++
			}
		}

		console.error(
			`Done: emitted ${emitted} affix rows, skipped ${skipped}, no-affix ${noAffix} (pool ${pool.length}).\n` +
				`  formats: ${JSON.stringify(formatCounts)}\n` +
				`  affix mix: ${JSON.stringify(affixCounts)}` +
				(multilocaleCount > 0
					? `\n  balance: emitted ${balanceEmitted}, skipped ${balanceSkipped}, iso ${JSON.stringify(balanceISO)}`
					: "")
		)

		return { emitted: emitted + balanceEmitted, skipped: skipped + balanceSkipped }
	},
}

// The venue shell needs a real register: fewer names than this and the rows read as templates again.
const VENUE_POOL_MIN_SIZE = 500
// While both classes are open: 80% terminal-only, 20% terminal-contrast.
const TERMINAL_ONLY_SHARE = 0.8

/**
 * #1569 root-fix shard. Both classes come from real non-Vermont OA streets and use the affix recipe's existing layout
 * diversity. v4.3.1 makes terminal-only 80% of the mix: the first 40/60 run moved a 100-row TRAIN sample only 4→11
 * while contrast was already 95/100 before training (93/100 after). Post-run audit found that the global affix relabel
 * pass corrupts many already-decomposed target rows into double suffixes; do not retrain this recipe until relabel is
 * idempotent over a decomposed street family. The 20% contrast leg remains explicit, additive to the already-strong
 * base distribution, and B2 still gates it unchanged.
 *
 * V2 (corpus 0.19.0, 2026-08-10 recipe review): the v4.3.3 board split (rich venue-led rows 5/43 vs bare 53/65) showed
 * the model separating template rows from real ones, and the venue shell was the giveaway — six fixed venue strings. v2
 * draws the venue shell from thousands of REAL HRSA facility names and raises its share (venue 30%, full 35%, bare 20%,
 * street-only 15%). Dose policy moved to the recipe's config side: weight ≤4 effective passes per run (Muennighoff
 * 2023's repetition knee) and the source is excluded from the augmentation pool — see the v4.4.0 config.
 */
export const suffixBoundaryRecipe: ShardRecipe = {
	name: "suffix-boundary",
	description: "US #1569 suffix boundary: OA terminal-only positives + over-sampled terminal contrasts",
	mode: "generate",
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 30_000
		const source = opts.sourceName ?? "synth-suffix-boundary"
		const sources = opts.golden ? [EVAL_SOURCE] : TRAIN_SOURCES

		// v2 venue shell: real facility names, loud when the source file is missing or thin.
		const venuePool = await readVenuePool(VENUE_POOL_CSV)

		if (venuePool.length < VENUE_POOL_MIN_SIZE) {
			throw new Error(
				`suffix-boundary v2 venue pool too thin: ${venuePool.length} names from ${VENUE_POOL_CSV} — ` +
					"is the usgov-hrsa-fqhc source present?"
			)
		}

		const shell: RenderRowOpts = { venues: venuePool, cuts: [0.35, 0.55, 0.7] }

		const pool: Record<SuffixBoundaryClass, USTuple[]> = {
			"terminal-only": [],
			"terminal-contrast": [],
		}

		for (const s of sources) {
			for (const tuple of await readTuples(s)) {
				const rowClass = classifySuffixBoundaryStreet(tuple.street)

				if (rowClass) {
					pool[rowClass].push(tuple)
				}
			}
		}

		if (!pool["terminal-only"].length || !pool["terminal-contrast"].length) {
			throw new Error(
				`Suffix-boundary source class missing: terminal-only=${pool["terminal-only"].length}, ` +
					`terminal-contrast=${pool["terminal-contrast"].length}`
			)
		}

		let emitted = 0
		let skipped = 0
		const classCounts: Record<SuffixBoundaryClass, number> = { "terminal-only": 0, "terminal-contrast": 0 }
		const terminalOnlyTarget = Math.round(count * 0.8)

		const classTargets: Record<SuffixBoundaryClass, number> = {
			"terminal-only": terminalOnlyTarget,
			"terminal-contrast": count - terminalOnlyTarget,
		}

		const formatCounts: Record<string, number> = {}
		let stemPairs = 0

		const emitOne = (
			rowClass: SuffixBoundaryClass,
			base: USTuple,
			parsed: NonNullable<ReturnType<typeof parseStreet>>,
			method: string
		): boolean => {
			const { street, components: streetComponents } = renderStreet(random, parsed)
			const { fmt, raw, components } = renderRow(random, base, street, streetComponents, shell)

			const canonical: CanonicalRow = {
				raw,
				components,
				country: "US",
				locale: "en-US",
				source,
				source_id: shardSourceID(source, { ...components, class: rowClass, n: String(emitted) }),
				corpus_version: "0.19.0",
				license:
					"OpenAddresses US (non-VT) skeletons; terminal suffix labels via USPS Pub-28 codex; venue shell from HRSA site names (US public domain)",
			}

			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				return false
			}

			write(JSON.stringify({ ...aligned.row, synth_method: method, synth_base_id: base.base_source_id }) + "\n")

			classCounts[rowClass]++
			formatCounts[fmt] = (formatCounts[fmt] ?? 0) + 1

			emitted++

			return true
		}

		// oxlint-disable-next-line eslint/no-unmodified-loop-condition -- emitted/skipped advance inside emitOne (a closure); the rule cannot see through the call
		while (emitted < count && emitted + skipped < count * 10) {
			const terminalOnlyOpen = classCounts["terminal-only"] < classTargets["terminal-only"]
			const terminalContrastOpen = classCounts["terminal-contrast"] < classTargets["terminal-contrast"]

			const rowClass: SuffixBoundaryClass =
				terminalOnlyOpen && terminalContrastOpen
					? random() < TERMINAL_ONLY_SHARE
						? "terminal-only"
						: "terminal-contrast"
					: terminalContrastOpen
						? "terminal-contrast"
						: "terminal-only"

			const classPool = pool[rowClass]
			const base = classPool[Math.floor(random() * classPool.length)]!
			const parsed = parseStreet(base.street, { allowNameProneTail: rowClass === "terminal-only" })

			if (!parsed) {
				skipped++

				continue
			}

			if (!emitOne(rowClass, base, parsed, `suffix-boundary:${rowClass}`)) continue

			// Stem-pair hard negative (v2, 2026-08-10 recipe review): after a terminal-only row
			// ('Menlo Park' + 'Road'), also emit the SAME stem without its true suffix as a
			// contrast row ('Menlo' + 'Park' under the canonical last-token rule). Sharing the stem
			// forces the model to key on the licensing evidence — the trailing true suffix — rather
			// than on name identity. Dose-neutral: these fill the existing 20% contrast target.
			if (
				rowClass === "terminal-only" &&
				classCounts["terminal-contrast"] < classTargets["terminal-contrast"] &&
				emitted < count &&
				random() < 0.5
			) {
				const stemParsed = parseStreet(parsed.name)

				if (
					stemParsed &&
					emitOne("terminal-contrast", base, stemParsed, "suffix-boundary:terminal-contrast:stem-pair")
				) {
					stemPairs++
				}
			}
		}

		console.error(
			`Done: emitted ${emitted}, skipped ${skipped}; source pools ${JSON.stringify({
				terminalOnly: pool["terminal-only"].length,
				terminalContrast: pool["terminal-contrast"].length,
			})}; classes ${JSON.stringify(classCounts)}; stem pairs ${stemPairs}; ` +
				`venue pool ${venuePool.length}; formats ${JSON.stringify(formatCounts)}`
		)

		return { emitted, skipped }
	},
}

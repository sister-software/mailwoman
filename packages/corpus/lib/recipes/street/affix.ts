/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import {
	DirectionalAbbreviation,
	lookupDirectional,
	matchCase,
	matchLeadingDirectional,
	matchTrailingSuffix,
	renderDirectional,
	US_STREET_SUFFIX_PREFERRED_ABBR,
	NAME_PRONE_US_SUFFIXES,
} from "@mailwoman/codex/us"
import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { stableSourceID } from "#adapters/utils"
import { readCSVRecords, readOATuples, recipeSourceID, type CorpusRecipe } from "#recipes/scaffold"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

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

const DIRECTIONAL_ABBRS = Object.values(DirectionalAbbreviation)

const INJECT_PREFIX_PROB = 0.3

interface USTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	base_source_id: string
}

interface BalanceTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	iso2: string
	order: string
}

type Prefix = Pick<NonNullable<ReturnType<typeof matchLeadingDirectional>>, "canonical" | "abbreviation">

async function readTuples(source: USSource): Promise<USTuple[]> {
	return readOATuples(source, {
		extra: (fields, _row, key) => ({
			...fields,
			region: source.region,
			base_source_id: `openaddresses:${source.csv}:${key}`,
		}),
	})
}

const title = (s: string): string =>
	s
		.toLowerCase()
		.split(/\s+/)
		.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ")

const isSuffixOrDirectional = (word: string): boolean =>
	matchTrailingSuffix(word) !== null || matchLeadingDirectional(word) !== null

function parseStreet(
	street: string,
	opts: { allowNameProneTail?: boolean } = {}
): { prefix: Prefix | null; name: string; suffix: string } | null {
	let words = street.trim().split(/\s+/)

	if (words.length < 2) return null
	let prefix: Prefix | null = null

	const lead = matchLeadingDirectional(street)

	if (lead && words.length > 2) {
		prefix = { canonical: lead.canonical, abbreviation: lead.abbreviation }
		words = words.slice(1)
	}

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

/**
 * Names the two street shapes the suffix-boundary recipe balances.
 *
 * In `terminal-only`, a name-prone suffix word precedes the real suffix and belongs to
 * the name; in `terminal-contrast`, the name-prone word is itself the final suffix.
 */
export type SuffixBoundaryClass = "terminal-only" | "terminal-contrast"

const TERMINAL_ONLY_MIN_WORDS = 3

/**
 * Classifies a street as `terminal-only` or `terminal-contrast`, or returns `null` when it is neither.
 *
 * A street whose final word is name-prone is `terminal-contrast` even when the word
 * before it is also name-prone, because only the final token is the suffix.
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

function renderStreet(
	random: () => number,
	parsed: { prefix: Prefix | null; name: string; suffix: string }
): { street: string; components: Partial<Record<ComponentTag, string>> } {
	const name = title(parsed.name)
	const parts: string[] = []
	const components: Partial<Record<ComponentTag, string>> = { street: name }

	let prefix = parsed.prefix

	if (!prefix && random() < INJECT_PREFIX_PROB) {
		const m = lookupDirectional(sample(DIRECTIONAL_ABBRS, random))!
		prefix = { canonical: m.directional, abbreviation: m.abbreviation }
	}

	if (prefix) {
		const rendered = renderDirectional(prefix, random() < 0.5 ? "abbr" : "full", "Aa")
		components.street_prefix = rendered
		parts.push(rendered)
	}

	parts.push(name)

	const full = title(parsed.suffix)

	const abbr = matchCase(
		US_STREET_SUFFIX_PREFERRED_ABBR[parsed.suffix as keyof typeof US_STREET_SUFFIX_PREFERRED_ABBR],
		"Aa"
	)

	const renderedSuffix = random() < 0.5 ? abbr : full
	components.street_suffix = renderedSuffix
	parts.push(renderedSuffix)

	return { street: parts.join(" "), components }
}

const VENUES = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]

const VENUE_POOL_CSV = dataRootPath(
	"corpus",
	"sources",
	"usgov-hrsa-fqhc",
	"Health_Center_Service_Delivery_and_LookAlike_Sites.csv"
)

const VENUE_NAME_MIN_LENGTH = 3
const VENUE_NAME_MAX_LENGTH = 60

async function readVenuePool(csvPath: PathBuilderLike): Promise<string[]> {
	const seen = new Set<string>()
	const pool: string[] = []

	for await (const record of readCSVRecords(csvPath)) {
		const name = (record.site_name ?? "").trim().replaceAll(/\s+/gu, " ")

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

interface RenderRowOpts {
	venues?: readonly string[]
	cutoffs?: readonly [number, number, number]
}

/**
 * Place a rendered street in a full, bare, street-only, or venue-prefixed address.
 */
export function renderRow(
	random: () => number,
	base: USTuple,
	street: string,
	streetComponents: Partial<Record<ComponentTag, string>>,
	opts: RenderRowOpts = {}
): { fmt: string; raw: string; components: Partial<Record<ComponentTag, string>> } {
	const venues = opts.venues ?? VENUES
	const [fullCutoff, bareCutoff, streetOnlyCutoff] = opts.cutoffs ?? [0.4, 0.65, 0.85]

	const hn = base.house_number,
		loc = base.locality,
		reg = base.region,
		pc = base.postcode

	const road = `${hn} ${street}`
	const withRoad: Partial<Record<ComponentTag, string>> = { house_number: hn, ...streetComponents }
	const r = random()

	if (r < fullCutoff)
		return {
			fmt: "full",
			raw: `${road}, ${tail(loc, reg, pc)}`,
			components: { ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
		}

	if (r < bareCutoff) return { fmt: "bare", raw: road, components: withRoad }

	if (r < streetOnlyCutoff) return { fmt: "street-only", raw: street, components: { ...streetComponents } }
	const v = sample(venues, random)

	return {
		fmt: "venue",
		raw: `${v}, ${road}, ${tail(loc, reg, pc)}`,
		components: { venue: v, ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
	}
}

async function readBalanceTuples(source: BalanceSource, limit: number): Promise<BalanceTuple[]> {
	return readOATuples(source, {
		limit,
		requirePostcode: true,
		extra: (fields, row) => ({
			...fields,
			region: row.region || source.region,
			iso2: source.iso2,
			order: source.order,
		}),
	})
}

function renderBalanceRow(t: BalanceTuple): { raw: string; components: Partial<Record<ComponentTag, string>> } {
	const { house_number: hn, street, locality: loc, postcode: pc, order } = t

	const components: Partial<Record<ComponentTag, string>> = { house_number: hn, street, locality: loc, postcode: pc }

	const raw = order === "fr" ? `${hn} ${street}, ${pc} ${loc}` : `${street} ${hn}, ${pc} ${loc}`

	return { raw, components }
}

/**
 * Street-affix recipe registered with the corpus builder.
 */
export const streetAffixRecipe: CorpusRecipe = {
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
				write(stringifyJSON({ raw, components, country: "US" }))

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

			write(stringifyJSON({ ...aligned.row, synth_method: "affix", synth_base_id: null }))

			emitted++
		}

		let balanceEmitted = 0
		let balanceSkipped = 0
		const balanceISO: Record<string, number> = {}

		if (multilocaleCount > 0) {
			const mlSources = opts.golden ? MULTILOCALE_EVAL_SOURCES : MULTILOCALE_SOURCES
			const perSource = Math.ceil((multilocaleCount * 3) / mlSources.length)
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

			// oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `M > 0` is an invariant guard against an empty pool rather than a progress condition
			while (M > 0 && balanceEmitted < multilocaleCount && mlGuard++ < multilocaleCount * 10) {
				const t = mlPool[Math.floor(random() * M)]!
				const { raw, components } = renderBalanceRow(t)

				if (![components.street, components.locality, components.postcode].every((s) => !!s && raw.includes(s))) {
					balanceSkipped++

					continue
				}

				balanceISO[t.iso2] = (balanceISO[t.iso2] ?? 0) + 1
				const locale = `${t.iso2.toLowerCase()}-${t.iso2}`

				if (opts.golden) {
					write(stringifyJSON({ raw, components, country: t.iso2 }))

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
					license: "OpenAddresses non-US skeletons (native-order postcode balance for the affix recipe)",
				}

				const aligned = alignRow(canonical)

				if (aligned.kind !== "labeled" || !aligned.row) {
					balanceSkipped++

					continue
				}

				write(stringifyJSON({ ...aligned.row, synth_method: "affix-balance", synth_base_id: null }))

				balanceEmitted++
			}
		}

		console.error(
			`Done: emitted ${emitted} affix rows, skipped ${skipped}, no-affix ${noAffix} (pool ${pool.length}).\n` +
				`  formats: ${stringifyJSON(formatCounts)}\n` +
				`  affix mix: ${stringifyJSON(affixCounts)}` +
				(multilocaleCount > 0
					? `\n  balance: emitted ${balanceEmitted}, skipped ${balanceSkipped}, iso ${stringifyJSON(balanceISO)}`
					: "")
		)

		return { emitted: emitted + balanceEmitted, skipped: skipped + balanceSkipped }
	},
}

const VENUE_POOL_MIN_SIZE = 500

const TERMINAL_ONLY_SHARE = 0.8

/**
 * Generates US rows that teach where a street name ends and its suffix begins,
 * mixing about 80% `terminal-only` and 20% `terminal-contrast` streets.
 *
 * It trains on non-Vermont OpenAddresses streets and reserves Vermont for the golden set.
 */
export const suffixBoundaryRecipe: CorpusRecipe = {
	name: "suffix-boundary",
	description: "US #1569 suffix boundary: OA terminal-only positives + over-sampled terminal contrasts",
	mode: "generate",
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 30_000
		const source = opts.sourceName ?? "synth-suffix-boundary"
		const sources = opts.golden ? [EVAL_SOURCE] : TRAIN_SOURCES

		const venuePool = await readVenuePool(VENUE_POOL_CSV)

		if (venuePool.length < VENUE_POOL_MIN_SIZE) {
			throw new Error(
				`suffix-boundary v2 venue pool too thin: ${venuePool.length} names from ${VENUE_POOL_CSV} — ` +
					"is the usgov-hrsa-fqhc source present?"
			)
		}

		const shell: RenderRowOpts = { venues: venuePool, cutoffs: [0.35, 0.55, 0.7] }

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
				source_id: recipeSourceID(source, { ...components, class: rowClass, n: String(emitted) }),
				corpus_version: "0.19.0",
				license:
					"OpenAddresses US (non-VT) skeletons; terminal suffix labels via USPS Pub-28 codex; venue shell from HRSA site names (US public domain)",
			}

			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				return false
			}

			write(stringifyJSON({ ...aligned.row, synth_method: method, synth_base_id: base.base_source_id }))

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
			const base = sample(classPool, random)
			const parsed = parseStreet(base.street, { allowNameProneTail: rowClass === "terminal-only" })

			if (!parsed) {
				skipped++

				continue
			}

			if (!emitOne(rowClass, base, parsed, `suffix-boundary:${rowClass}`)) continue

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
			`Done: emitted ${emitted}, skipped ${skipped}; source pools ${stringifyJSON({
				terminalOnly: pool["terminal-only"].length,
				terminalContrast: pool["terminal-contrast"].length,
			})}; classes ${stringifyJSON(classCounts)}; stem pairs ${stemPairs}; ` +
				`venue pool ${venuePool.length}; formats ${stringifyJSON(formatCounts)}`
		)

		return { emitted, skipped }
	},
}

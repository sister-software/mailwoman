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
import { spawnSync } from "node:child_process"

import { stableSourceId } from "../adapter.js"
import { alignRow } from "../align.js"
import type { CanonicalRow } from "../types.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

// Same OA cache as the unit shard. Train = every NON-Vermont state; eval = Vermont (the holdout).
interface UsSource {
	zip: string
	csv: string
	region: string
}
const TRAIN_SOURCES: readonly UsSource[] = [
	{ zip: "/tmp/oa-cache/us__ca__berkeley.zip", csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__ca__marin.zip", csv: "us/ca/marin.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__dc__statewide.zip", csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: "/tmp/oa-cache/us__ia__statewide.zip", csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv", region: "IL" },
	{ zip: "/tmp/oa-cache/us__mt__statewide.zip", csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: "/tmp/oa-cache/us__sd__statewide.zip", csv: "us/sd/statewide.csv", region: "SD" },
]
const EVAL_SOURCE: UsSource = { zip: "/tmp/oa-cache/us__vt__statewide.zip", csv: "us/vt/statewide.csv", region: "VT" }

// Multi-locale BALANCE sources (--multilocale-count > 0). These rows carry NO affix split — they exist
// only to keep the postcode-ORDER distribution multi-locale. Native-order rendering mirrors
// build-country-shard-balanced.mjs: FR = number-street, postcode-city; DE/IT/NL = street-number,
// postcode-city. `order` drives the body.
interface BalanceSource {
	zip: string
	csv: string
	iso2: string
	region: string
	order: string
}
const MULTILOCALE_SOURCES: readonly BalanceSource[] = [
	{ zip: "/tmp/oa-cache/de__sn__statewide.zip", csv: "de/sn/statewide.csv", iso2: "DE", region: "", order: "eu" },
	{ zip: "/tmp/oa-cache/fr__countrywide.zip", csv: "fr/countrywide.csv", iso2: "FR", region: "", order: "fr" },
	{ zip: "/tmp/oa-cache/it__countrywide.zip", csv: "it/countrywide.csv", iso2: "IT", region: "", order: "eu" },
	{ zip: "/tmp/oa-cache/nl__countrywide.zip", csv: "nl/countrywide.csv", iso2: "NL", region: "", order: "eu" },
]
const MULTILOCALE_EVAL_SOURCES: readonly BalanceSource[] = [
	{ zip: "/tmp/oa-cache/de__berlin.zip", csv: "de/berlin.csv", iso2: "DE", region: "", order: "eu" },
]

const DIRECTIONAL_ABBRS = Object.values(DirectionalAbbreviation) // ["N","E","S","W","NE","NW","SE","SW"]
const INJECT_PREFIX_PROB = 0.3 // fraction of prefix-less streets that get a synthetic directional

/** A real US skeleton tuple read from a cached OA zip. */
interface UsTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
}

/** A non-US BALANCE tuple (carries a postcode + native order). */
interface BalanceTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	iso2: string
	order: string
}

/** Prefix carried through render — the (canonical, abbreviation) pair `renderDirectional` consumes. */
type Prefix = Pick<NonNullable<ReturnType<typeof matchLeadingDirectional>>, "canonical" | "abbreviation">

/** Minimal RFC-4180-ish splitter (handles quoted fields). */
function splitCsv(line: string): string[] {
	const out: string[] = []
	let cur = ""
	let inQ = false
	for (let i = 0; i < line.length; i++) {
		const c = line[i]
		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else inQ = false
			} else cur += c
		} else if (c === '"') inQ = true
		else if (c === ",") {
			out.push(cur)
			cur = ""
		} else cur += c
	}
	out.push(cur)
	return out
}

/** Stream real US tuples (number/street/city/postcode) out of a cached OA zip. */
function readTuples(source: UsSource): UsTuple[] {
	const r = spawnSync("unzip", ["-p", source.zip, source.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (name: string): number => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: UsTuple[] = []
	const seen = new Set<string>()
	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li]!)
		const street = get(cells, iStreet)
		const locality = get(cells, iCity)
		const house_number = get(cells, iNum)
		if (!street || !locality || !house_number) continue
		const key = `${house_number}|${street}|${locality}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({ house_number, street, locality, region: source.region, postcode: get(cells, iPost) })
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
 * Split an OA street into { prefix?, name, suffix } using the codex. Requires a trailing suffix and
 * a non-empty name that isn't itself an affix token. Returns null when the street has no usable
 * suffix.
 */
function parseStreet(street: string): { prefix: Prefix | null; name: string; suffix: string } | null {
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
	if (!name || isSuffixOrDirectional(name)) return null
	return { prefix, name, suffix }
}

/**
 * Render the affix-split street in random surface forms (abbrev vs expanded per affix),
 * Title-cased.
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
	const full = title(parsed.suffix) // canonical is uppercase word → "Street"
	const abbr = matchCase(
		US_STREET_SUFFIX_PREFERRED_ABBR[parsed.suffix as keyof typeof US_STREET_SUFFIX_PREFERRED_ABBR],
		"Aa"
	) // "AVE" → "Ave"
	const renderedSuffix = random() < 0.5 ? abbr : full
	components.street_suffix = renderedSuffix
	parts.push(renderedSuffix)

	return { street: parts.join(" "), components }
}

/** Synthetic recipient/venue prefixes — the arena's "JOHN DOE, ACME INC, …" pattern. */
const VENUES = ["John Doe", "Jane Smith", "Acme Inc", "Wayne Enterprises", "Maria Garcia", "Riverside Clinic"]

const tail = (loc: string, reg: string, pc: string): string => (pc ? `${loc}, ${reg} ${pc}` : `${loc}, ${reg}`)

/**
 * Embed the rendered street in a RANDOM layout so the model recognizes affixes wherever the street
 * sits: full address, bare house+street, street-only (pure affix parse), or venue-prefixed.
 */
function renderRow(
	random: () => number,
	base: UsTuple,
	street: string,
	streetComponents: Partial<Record<ComponentTag, string>>
): { fmt: string; raw: string; components: Partial<Record<ComponentTag, string>> } {
	const hn = base.house_number,
		loc = base.locality,
		reg = base.region,
		pc = base.postcode
	const road = `${hn} ${street}`
	const withRoad: Partial<Record<ComponentTag, string>> = { house_number: hn, ...streetComponents }
	const r = random()
	if (r < 0.4)
		return {
			fmt: "full",
			raw: `${road}, ${tail(loc, reg, pc)}`,
			components: { ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
		}
	if (r < 0.65) return { fmt: "bare", raw: road, components: withRoad }
	if (r < 0.85) return { fmt: "street-only", raw: street, components: { ...streetComponents } }
	const v = VENUES[Math.floor(random() * VENUES.length)]!
	return {
		fmt: "venue",
		raw: `${v}, ${road}, ${tail(loc, reg, pc)}`,
		components: { venue: v, ...withRoad, locality: loc, region: reg, ...(pc ? { postcode: pc } : {}) },
	}
}

/**
 * Capped reader for the multi-locale BALANCE sources. The FR/IT/NL countrywide extracts are
 * GB-scale; reading the whole CSV blows V8's string limit, so cap the bytes with `head` (mirrors
 * build-country-shard-balanced.mjs). Only keeps tuples that carry a POSTCODE.
 */
function readBalanceTuples(source: BalanceSource, limit: number): BalanceTuple[] {
	const maxLines = Math.max(limit * 8, 20000) + 1
	const r = spawnSync("bash", ["-c", `unzip -p "${source.zip}" "${source.csv}" | head -n ${maxLines}`], {
		maxBuffer: 1024 * 1024 * 1024,
		encoding: "buffer",
	})
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)
		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return []
	const header = splitCsv(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (n: string): number => header.indexOf(n)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iCity = idx("city"),
		iRegion = idx("region"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: BalanceTuple[] = []
	const seen = new Set<string>()
	for (let li = 1; li < lines.length && tuples.length < limit; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li]!)
		const street = get(cells, iStreet),
			locality = get(cells, iCity),
			house_number = get(cells, iNum),
			postcode = get(cells, iPost)
		if (!street || !locality || !house_number || !postcode) continue // postcode is required for balance
		const key = `${house_number}|${street}|${locality}`.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({
			house_number,
			street,
			locality,
			region: get(cells, iRegion) || source.region,
			postcode,
			iso2: source.iso2,
			order: source.order,
		})
	}
	return tuples
}

/**
 * Render a non-US BALANCE row in native order — NO affix split, NO country token. `street` is the
 * OA value verbatim. The sole job is to put a postcode in its native position so the shard doesn't
 * pull the model US-ward.
 */
function renderBalanceRow(t: BalanceTuple): { raw: string; components: Partial<Record<ComponentTag, string>> } {
	const { house_number: hn, street, locality: loc, postcode: pc, order } = t
	// region is intentionally omitted — it isn't rendered in `raw`, so labeling it would fail alignment.
	const components: Partial<Record<ComponentTag, string>> = { house_number: hn, street, locality: loc, postcode: pc }
	const raw =
		order === "fr"
			? `${hn} ${street}, ${pc} ${loc}` // French: number-street, postcode-city
			: `${street} ${hn}, ${pc} ${loc}` // DE/IT/NL: street-number, postcode-city
	return { raw, components }
}

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
		const count = opts.count ?? 50000
		const source = opts.sourceName ?? "synth-affix"
		const multilocaleCount = opts.multilocaleCount ?? 0
		const sources = opts.golden ? [EVAL_SOURCE] : TRAIN_SOURCES

		const pool: UsTuple[] = []
		for (const s of sources) {
			const t = readTuples(s)
			console.error(`  ${s.csv}: ${t.length} unique tuples`)
			for (const x of t) pool.push(x)
		}
		if (pool.length === 0) {
			throw new Error("No US tuples found — are the cached OA zips present in /tmp/oa-cache?")
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
			if (hasP && streetComponents.street_suffix) affixCounts.both++
			else if (hasP) affixCounts.prefix++
			else affixCounts.suffix++

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
				source_id: stableSourceId(source, components),
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
		const balanceIso: Record<string, number> = {}
		if (multilocaleCount > 0) {
			const mlSources = opts.golden ? MULTILOCALE_EVAL_SOURCES : MULTILOCALE_SOURCES
			const perSource = Math.ceil((multilocaleCount * 3) / mlSources.length) // over-read; balance locales
			const mlPool: BalanceTuple[] = []
			for (const s of mlSources) {
				const t = readBalanceTuples(s, perSource)
				console.error(`  balance ${s.csv} (${s.iso2}): ${t.length} tuples`)
				for (const x of t) mlPool.push(x)
			}
			const M = mlPool.length
			let mlGuard = 0
			while (M > 0 && balanceEmitted < multilocaleCount && mlGuard++ < multilocaleCount * 10) {
				const t = mlPool[Math.floor(random() * M)]!
				const { raw, components } = renderBalanceRow(t)
				// Every component surface must survive in raw, else alignment can't label it.
				if (![components.street, components.locality, components.postcode].every((s) => !!s && raw.includes(s))) {
					balanceSkipped++
					continue
				}
				balanceIso[t.iso2] = (balanceIso[t.iso2] ?? 0) + 1
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
					source_id: stableSourceId(source, components),
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
					? `\n  balance: emitted ${balanceEmitted}, skipped ${balanceSkipped}, iso ${JSON.stringify(balanceIso)}`
					: "")
		)
		return { emitted: emitted + balanceEmitted, skipped: skipped + balanceSkipped }
	},
}

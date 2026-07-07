/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `unit` shard recipe — US secondary-unit coverage (#451, the v0-parity `unit` gap). Onto REAL US
 *   OpenAddresses skeletons (cached zips under `/tmp/oa-cache`) it INJECTS a USPS Pub-28 Appendix
 *   C2 secondary-unit designator (the `@mailwoman/codex/us` table), varying the surface form
 *   (canonical "Apartment" vs approved "Apt") AND the unit's POSITION (after-street / unit-first /
 *   bare / venue-prefixed) per row, so the model learns to RECOGNIZE the designator wherever it
 *   sits. The inline synthesis (the OA-CSV reader, the designator tables, `makeUnit`/`renderUnit`)
 *   is ported faithfully from scripts/build-unit-shard.mjs.
 *
 *   `--golden`: a held-out eval over the VERMONT source only (the corpus `defaultHoldout`, never
 *   trained) with a different seed, emitting `{raw, components, country}` for per-locale-f1. Train
 *   uses every NON-Vermont US source. Designators are injected in both (OA carries none), so the
 *   eval measures designator recognition on held-out addresses.
 *
 *   NOTE: this is a `generate`-mode recipe but it still reads REAL tuples off disk (`unzip` of the
 *   cached OA zips) — `--count` bounds the OUTPUT, not the input. The passed `random` (the
 *   framework LCG) is consumed in the exact call order the legacy script used.
 */

import { spawnSync } from "node:child_process"

import { US_UNIT_DESIGNATOR_PREFERRED_ABBR, type UsUnitDesignator } from "@mailwoman/codex/us"
import type { ComponentTag } from "@mailwoman/core/types"

import { stableSourceID } from "../adapter.js"
import { alignRow } from "../align.js"
import type { CanonicalRow } from "../types.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

/** A cached OpenAddresses extract: the zip, the CSV member, and the implied (file-level) region. */
interface UnitSource {
	zip: string
	csv: string
	region: string
}

// OA REGION is empty for US per-state extracts — the region is implied by the file. Train sources are
// every NON-Vermont state cached; eval is Vermont only (the corpus holdout).
const TRAIN_SOURCES: readonly UnitSource[] = [
	{ zip: "/tmp/oa-cache/us__ca__berkeley.zip", csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__ca__marin.zip", csv: "us/ca/marin.csv", region: "CA" },
	{ zip: "/tmp/oa-cache/us__dc__statewide.zip", csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: "/tmp/oa-cache/us__ia__statewide.zip", csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv", region: "IL" },
	{ zip: "/tmp/oa-cache/us__mt__statewide.zip", csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: "/tmp/oa-cache/us__sd__statewide.zip", csv: "us/sd/statewide.csv", region: "SD" },
]
const EVAL_SOURCE: UnitSource = { zip: "/tmp/oa-cache/us__vt__statewide.zip", csv: "us/vt/statewide.csv", region: "VT" }

// USPS Pub-28 C2 designators that take a secondary identifier ("Apt 4B"). Weighted toward the common
// ones the v0-parity arena failed on (Apt/Ste/Unit/Fl/Rm). Standalone designators (Basement, Lobby,
// Penthouse) are emitted occasionally with no id.
const ID_DESIGNATORS: readonly UsUnitDesignator[] = [
	"APARTMENT",
	"SUITE",
	"UNIT",
	"FLOOR",
	"ROOM",
	"BUILDING",
	"DEPARTMENT",
	"SPACE",
	"LOT",
]
const STANDALONE_DESIGNATORS: readonly UsUnitDesignator[] = [
	"BASEMENT",
	"LOBBY",
	"PENTHOUSE",
	"FRONT",
	"REAR",
	"UPPER",
	"LOWER",
]
const ID_WEIGHT = 0.85 // 85% id-bearing designators, 15% standalone
const SYNTH_IDS: readonly string[] = ["4B", "200", "12", "3", "A", "101", "5", "2A", "310", "B", "7", "1500", "404"]

/** A real US tuple read out of a cached OA zip (number/street/city/postcode + the bare OA unit id). */
interface UnitTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	oaUnit: string
}

/** Minimal RFC-4180-ish splitter (handles quoted fields). */
function splitCSV(line: string): string[] {
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
				} else {
					inQ = false
				}
			} else {
				cur += c
			}
		} else if (c === '"') {
			inQ = true
		} else if (c === ",") {
			out.push(cur)
			cur = ""
		} else {
			cur += c
		}
	}
	out.push(cur)

	return out
}

/** Stream real US tuples (number/street/city/postcode + the bare OA unit id) out of a cached OA zip. */
function readTuples(source: UnitSource): UnitTuple[] {
	const r = spawnSync("unzip", ["-p", source.zip, source.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })

	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${source.zip} (status ${r.status})`)

		return []
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)

	if (lines.length < 2) return []
	const header = splitCSV(lines[0]!).map((h) => h.trim().toLowerCase())
	const idx = (name: string): number => header.indexOf(name)
	const iNum = idx("number"),
		iStreet = idx("street"),
		iUnit = idx("unit"),
		iCity = idx("city"),
		iPost = idx("postcode")
	const get = (cells: string[], i: number): string => (i >= 0 && i < cells.length ? (cells[i] ?? "").trim() : "")
	const tuples: UnitTuple[] = []
	const seen = new Set<string>()

	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCSV(lines[li]!)
		const street = get(cells, iStreet)
		const locality = get(cells, iCity)
		const house_number = get(cells, iNum)

		if (!street || !locality || !house_number) continue
		const key = `${house_number}|${street}|${locality}`.toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)
		tuples.push({
			house_number,
			street,
			locality,
			region: source.region,
			postcode: get(cells, iPost),
			oaUnit: get(cells, iUnit),
		})
	}

	return tuples
}

/** Title-case a canonical/abbrev designator ("APARTMENT" → "Apartment", "APT" → "Apt"). */
const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/** Build an injected unit string ("Apt 4B"), varying canonical vs approved-abbrev form per row. */
function makeUnit(random: () => number, oaUnit: string): string {
	const standalone = random() >= ID_WEIGHT
	const pool = standalone ? STANDALONE_DESIGNATORS : ID_DESIGNATORS
	const canonical = pool[Math.floor(random() * pool.length)]!
	// Vary the surface form 50/50 (this is the #454 expand/abbreviate variety, baked into the shard).
	const designator = random() < 0.5 ? title(canonical) : title(US_UNIT_DESIGNATOR_PREFERRED_ABBR[canonical])

	if (standalone) return designator
	const id = oaUnit && oaUnit.length <= 6 ? oaUnit : SYNTH_IDS[Math.floor(random() * SYNTH_IDS.length)]!

	return `${designator} ${id}`
}

/** Synthetic recipient/venue prefixes — the "JOHN DOE, ACME INC, ..." arena pattern. */
const VENUES: readonly string[] = [
	"John Doe",
	"Jane Smith",
	"Acme Inc",
	"Wayne Enterprises",
	"Stark Industries",
	"Globex Corp",
	"Maria Garcia",
	"Robert Chen",
	"Oak Street Dental",
	"Riverside Clinic",
]

/** Address tail: "City, ST 12345" (or no postcode). */
const tail = (loc: string, reg: string, pc: string): string => (pc ? `${loc}, ${reg} ${pc}` : `${loc}, ${reg}`)

/**
 * Render a unit row in a RANDOM layout — units spread across positions, the city/state tail dropped on bare rows, a
 * recipient/venue prefixed on the venue format — so the model learns to RECOGNIZE the designator wherever it sits.
 * Returns {fmt, raw, components}.
 */
function renderUnit(
	random: () => number,
	base: UnitTuple,
	unit: string
): { fmt: string; raw: string; components: Partial<Record<ComponentTag, string>> } {
	const hn = base.house_number,
		street = base.street,
		loc = base.locality,
		reg = base.region,
		pc = base.postcode
	const road = `${hn} ${street}`
	const full: Partial<Record<ComponentTag, string>> = {
		house_number: hn,
		street,
		unit,
		locality: loc,
		region: reg,
		...(pc ? { postcode: pc } : {}),
	}
	const r = random()

	if (r < 0.34) return { fmt: "full-after", raw: `${road} ${unit}, ${tail(loc, reg, pc)}`, components: full }

	if (r < 0.52) return { fmt: "full-first", raw: `${unit}, ${road}, ${tail(loc, reg, pc)}`, components: full }

	if (r < 0.68) return { fmt: "bare-after", raw: `${road} ${unit}`, components: { house_number: hn, street, unit } }

	if (r < 0.84) return { fmt: "bare-first", raw: `${unit} ${road}`, components: { house_number: hn, street, unit } }
	const v = VENUES[Math.floor(random() * VENUES.length)]!

	return { fmt: "venue", raw: `${v}, ${road} ${unit}, ${tail(loc, reg, pc)}`, components: { venue: v, ...full } }
}

export const unitRecipe: ShardRecipe = {
	name: "unit",
	description: "US secondary-unit rows (#451): real OA skeletons + injected USPS Pub-28 C2 unit designators",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the held-out VT eval slice ({raw, components, country})" }],
	async run(opts, write) {
		if (opts.count == null) throw new Error("unit recipe requires --count <N>")
		const count = opts.count
		// Legacy build-unit-shard.mjs seeded mulberry32 with the raw seed: `const random = mulberry32(opts.seed)`.
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-unit"
		const sources = opts.golden ? [EVAL_SOURCE] : TRAIN_SOURCES

		const pool: UnitTuple[] = []

		for (const s of sources) {
			const t = readTuples(s)
			console.error(`  ${s.csv}: ${t.length} unique tuples`)

			for (const x of t) {
				pool.push(x)
			}
		}

		if (pool.length === 0) {
			throw new Error("No US tuples found — are the cached OA zips present in /tmp/oa-cache?")
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 6) {
			const base = pool[Math.floor(random() * N)]!
			const unit = makeUnit(random, base.oaUnit)
			const { raw, components } = renderUnit(random, base, unit)

			// The unit must survive verbatim in raw, else alignment can't label it.
			if (!raw.includes(unit)) {
				skipped++
				continue
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
				license: "OpenAddresses US (non-VT) skeletons + injected USPS Pub-28 C2 unit designators",
			}
			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			write(JSON.stringify({ ...aligned.row, synth_method: "unit", synth_base_id: null }) + "\n")
			emitted++
		}

		return { emitted, skipped }
	},
}

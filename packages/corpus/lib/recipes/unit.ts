/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `unit` recipe — US secondary-unit coverage (#451, the v0-parity `unit` gap). Onto real US
 *   OpenAddresses skeletons (cached zips under `$MAILWOMAN_DATA_ROOT/oa-cache`) it injects a USPS Pub-28 Appendix
 *   C2 secondary-unit designator (the `@mailwoman/codex/us` table), varying the surface form
 *   (canonical "Apartment" vs approved "Apt") and the unit's position (after-street / unit-first /
 *   bare / venue-prefixed) per row, so the model learns to recognize the designator wherever it
 *   sits. The inline synthesis (the OA-CSV reader, the designator tables, `makeUnit`/`renderUnit`)
 *   is ported faithfully from the root build script it replaced.
 *
 *   `--golden`: a held-out eval over the vermont source only (the corpus `defaultHoldout`, never
 *   trained) with a different seed, emitting `{raw, components, country}` for per-locale-f1. Train
 *   uses every NON-Vermont US source. Designators are injected in both (OA carries none), so the
 *   eval measures designator recognition on held-out addresses.
 *
 *   note: this is a `generate`-mode recipe but it still reads real tuples off disk (`unzip` of the
 *   cached OA zips) — `--count` bounds the output rather than the input. The passed `random` (the
 *   framework LCG) is consumed in the exact call order the legacy script used.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { US_UNIT_DESIGNATOR_PREFERRED_ABBR, type USUnitDesignator } from "@mailwoman/codex/us"
import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { stableSourceID } from "#adapters/utils"
import { readOATuples, type CorpusRecipe } from "#recipes/scaffold"
import { EVAL_SOURCE, TRAIN_SOURCES, type UnitSource } from "#recipes/unit/sources"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

/**
 * Longest OpenAddresses unit id reused verbatim.
 *
 * Longer values are building codes or free text, so a synthetic id is substituted instead.
 */
const MAX_REAL_UNIT_ID_LENGTH = 6

/**
 * USPS Pub-28 C2 designators that take a secondary identifier ("Apt 4B").
 *
 * Weighted toward the common ones the v0-parity arena failed on (Apt/Ste/Unit/Fl/Rm).
 * Standalone designators (Basement, Lobby, Penthouse) are emitted occasionally with no id.
 */
const ID_DESIGNATORS: readonly USUnitDesignator[] = [
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

const STANDALONE_DESIGNATORS: readonly USUnitDesignator[] = [
	"BASEMENT",
	"LOBBY",
	"PENTHOUSE",
	"FRONT",
	"REAR",
	"UPPER",
	"LOWER",
]

/**
 * 85% id-containing designators, 15% standalone.
 */
const ID_WEIGHT = 0.85

/**
 * Share of id-containing rows written with the `#` sigil instead of a word designator.
 *
 * A minority rather than a replacement: `#` reads as a unit designator here and as a private-mailbox
 * leader in `synthesizers/po-box.ts`, so the token cannot decide between them and the context has to.
 * `US_PMB_LEADERS` excludes it for the same reason.
 *
 * A promotion check over this recipe owes a PO-box arm, since a gain on units
 * can be paid for with a loss on `PMB #`.
 */
const SIGIL_WEIGHT = 0.2
const SYNTH_IDS: readonly string[] = ["4B", "200", "12", "3", "A", "101", "5", "2A", "310", "B", "7", "1500", "404"]

/**
 * A real US tuple read out of a cached OA zip (number/street/city/postcode + the bare OA unit id).
 */
export interface UnitTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
	oaUnit: string
}

/**
 * Stream real US tuples (number/street/city/postcode + the bare OA unit id) out of a cached OA zip.
 */
async function readTuples(source: UnitSource): Promise<UnitTuple[]> {
	return readOATuples(source, {
		extra: (fields, row) => ({ ...fields, region: source.region, oaUnit: row.unit ?? "" }),
	})
}

/**
 * Title-case a canonical/abbrev designator ("apartment" → "Apartment", "APT" → "Apt").
 */
const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/**
 * Build an injected unit string ("Apt 4B"), varying canonical vs approved-abbrev form per row.
 */
export function makeUnit(random: () => number, oaUnit: string): string {
	const standalone = random() >= ID_WEIGHT
	const pool = standalone ? STANDALONE_DESIGNATORS : ID_DESIGNATORS
	const canonical = sample(pool, random)
	// Vary the surface form 50/50 (this is the #454 expand/abbreviate variety, baked into the recipe output).
	const designator = random() < 0.5 ? title(canonical) : title(US_UNIT_DESIGNATOR_PREFERRED_ABBR[canonical])

	if (standalone) return designator

	const id = oaUnit && oaUnit.length <= MAX_REAL_UNIT_ID_LENGTH ? oaUnit : sample(SYNTH_IDS, random)

	// Both spacings: the sign and the id are one component either way, and attesting one
	// surface leaves the other reachable only by generalization the model does not make here.
	if (random() < SIGIL_WEIGHT) return random() < 0.5 ? `#${id}` : `# ${id}`

	return `${designator} ${id}`
}

/**
 * Synthetic recipient/venue prefixes — the "john DOE, acme INC, ..." arena pattern.
 */
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

/**
 * Share of tails that write a comma before the postcode — `Athens, GA, 30601`.
 *
 * This is the counter-reading of the bare unit below, and it is here
 * because nothing else in the corpus carries it.
 * Counted over one epoch of the shipped mixture, a bare number standing alone in a later
 * comma segment appears zero times at either level, so the position is unattested in both
 * directions: teaching `…, 101, …` as a unit without this would make the unit reading
 * the only evidence a model has for a segment users also write a postcode into.
 */
const COMMA_POSTCODE_WEIGHT = 0.15

/**
 * Address tail: "City, ST 12345" (or no postcode), with the postcode occasionally on its own comma segment.
 */
const tail = (random: () => number, loc: string, reg: string, pc: string): string => {
	if (!pc) return `${loc}, ${reg}`

	return random() < COMMA_POSTCODE_WEIGHT ? `${loc}, ${reg}, ${pc}` : `${loc}, ${reg} ${pc}`
}

/**
 * The identifier inside a rendered unit, when the unit has one.
 *
 * A standalone designator ("Basement") has none, and neither does a letter-only id:
 * a bare `A` between commas is not a shape worth attesting, while `4B` and `101` are.
 */
function unitIdentifier(unit: string): string | undefined {
	const last = unit.replace(/^#\s*/, "").split(/\s+/).at(-1)

	return last && /\d/.test(last) ? last : undefined
}

// Layouts: 26% full-after, 5% full-comma, 3% full-comma-bare, 18% full-first,
// 16% bare-after, 16% bare-first, 16% venue.
//
// A comma before the unit is its own surface — the delimiter decides whether the span
// reads as a unit at all, independently of which designator sits in it.
// `full-comma` is carved out of `full-after` alone so every later cutoff keeps the share
// it had, and `full-comma-bare` out of `full-comma` for the same reason.
//
// `full-comma-bare` writes the identifier with no designator at all —
// `301 College Ave, 101, Athens, GA 30601` — which is the one unit surface
// carrying no token that decides its reading.
// It is deliberately the smallest share and confined to the comma layout:
// a bare id anywhere else is indistinguishable from a house number.
const FULL_AFTER_CUTOFF = 0.26
const FULL_COMMA_CUTOFF = 0.31
const FULL_COMMA_BARE_CUTOFF = 0.34
const FULL_FIRST_CUTOFF = 0.52
const BARE_AFTER_CUTOFF = 0.68
const BARE_FIRST_CUTOFF = 0.84

/**
 * Render a unit row in a random layout — units spread across positions, the city/state
 * tail dropped on bare rows, a recipient/venue prefixed on the venue format —
 * so the model learns to recognize the designator wherever it sits.
 *
 * Returns {fmt, raw, components}.
 */
export function renderUnit(
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

	if (r < FULL_AFTER_CUTOFF)
		return { fmt: "full-after", raw: `${road} ${unit}, ${tail(random, loc, reg, pc)}`, components: full }

	if (r < FULL_COMMA_CUTOFF)
		return { fmt: "full-comma", raw: `${road}, ${unit}, ${tail(random, loc, reg, pc)}`, components: full }

	if (r < FULL_COMMA_BARE_CUTOFF) {
		const identifier = unitIdentifier(unit)

		// A standalone designator has no identifier to write bare, so it keeps the
		// designator form rather than disappearing from the layout.
		if (identifier) {
			return {
				fmt: "full-comma-bare",
				raw: `${road}, ${identifier}, ${tail(random, loc, reg, pc)}`,
				components: { ...full, unit: identifier },
			}
		}

		return { fmt: "full-comma", raw: `${road}, ${unit}, ${tail(random, loc, reg, pc)}`, components: full }
	}

	if (r < FULL_FIRST_CUTOFF)
		return { fmt: "full-first", raw: `${unit}, ${road}, ${tail(random, loc, reg, pc)}`, components: full }

	if (r < BARE_AFTER_CUTOFF)
		return { fmt: "bare-after", raw: `${road} ${unit}`, components: { house_number: hn, street, unit } }

	if (r < BARE_FIRST_CUTOFF)
		return { fmt: "bare-first", raw: `${unit} ${road}`, components: { house_number: hn, street, unit } }

	const v = sample(VENUES, random)

	return {
		fmt: "venue",
		raw: `${v}, ${road} ${unit}, ${tail(random, loc, reg, pc)}`,
		components: { venue: v, ...full },
	}
}

/**
 * Recipe registered with the corpus builder — see the file header for the parse behaviour
 * it exists to exercise, and `description` below for the surface form it generates.
 */
export const unitRecipe: CorpusRecipe = {
	name: "unit",
	description: "US secondary-unit rows (#451): real OA skeletons + injected USPS Pub-28 C2 unit designators",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the held-out VT eval set ({raw, components, country})" }],
	async run(opts, write) {
		if (opts.count == null) throw new Error("unit recipe requires --count <N>")
		const count = opts.count
		// The root build script this recipe replaced seeded mulberry32 with the raw
		// seed: `const random = mulberry32(opts.seed)`.
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-unit"
		const sources = opts.golden ? [EVAL_SOURCE] : TRAIN_SOURCES

		const pool: UnitTuple[] = []

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
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 6) {
			const base = pool[Math.floor(random() * N)]!
			const unit = makeUnit(random, base.oaUnit)
			const { raw, components } = renderUnit(random, base, unit)
			// The rendered component rather than the designator form handed in: `full-comma-bare` writes the
			// identifier alone, so checking the pre-render string would refuse every row of that layout.
			const rendered = components.unit

			// The unit must survive verbatim in raw, else alignment can't label it.
			if (!rendered || !raw.includes(rendered)) {
				skipped++

				continue
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
				license: "OpenAddresses US (non-VT) skeletons + injected USPS Pub-28 C2 unit designators",
			}

			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(stringifyJSON({ ...aligned.row, synth_method: "unit", synth_base_id: null }))

			emitted++
		}

		return { emitted, skipped }
	},
}

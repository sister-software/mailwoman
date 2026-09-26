/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `unit` recipe: injects a USPS Pub-28 C2 secondary-unit designator into real US OpenAddresses
 *   skeletons, varying the surface form and the unit's position per row.
 *
 *   `--golden` emits the held-out Vermont eval (`{raw, components, country}`) with a different
 *   seed; train uses every non-Vermont US source. `--count` bounds the output, not the input.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { US_UNIT_DESIGNATOR_PREFERRED_ABBR, type USUnitDesignator } from "@mailwoman/codex/us"
import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { stableSourceID } from "#adapters/utils"
import { readOATuples, requireRegister, type CorpusRecipe } from "#recipes/scaffold"
import { EVAL_SOURCE, TRAIN_SOURCES, type UnitSource } from "#recipes/unit/sources"
import { SurfaceOrigin } from "#types"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

/**
 * Longer OpenAddresses unit ids are building codes or free text, so a synthetic id is substituted instead.
 */
const MAX_REAL_UNIT_ID_LENGTH = 6

/**
 * USPS Pub-28 C2 designators that take a secondary identifier ("Apt 4B").
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

const ID_WEIGHT = 0.85

/**
 * Share of id-containing rows written with the `#` sigil, which also leads a private
 * mailbox, so only context can decide the reading.
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

async function readTuples(source: UnitSource): Promise<UnitTuple[]> {
	return readOATuples(source, {
		extra: (fields, row) => ({ ...fields, region: source.region, oaUnit: row.unit ?? "" }),
	})
}

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/**
 * Build an injected unit string ("Apt 4B"), varying canonical vs approved-abbrev form per row.
 */
export function makeUnit(random: () => number, oaUnit: string): string {
	const standalone = random() >= ID_WEIGHT
	const pool = standalone ? STANDALONE_DESIGNATORS : ID_DESIGNATORS
	const canonical = sample(pool, random)
	const designator = random() < 0.5 ? title(canonical) : title(US_UNIT_DESIGNATOR_PREFERRED_ABBR[canonical])

	if (standalone) return designator

	const id = oaUnit && oaUnit.length <= MAX_REAL_UNIT_ID_LENGTH ? oaUnit : sample(SYNTH_IDS, random)

	// Both spacings are emitted: attesting one leaves the other reachable only by
	// generalization the model does not make here.
	if (random() < SIGIL_WEIGHT) return random() < 0.5 ? `#${id}` : `# ${id}`

	return `${designator} ${id}`
}

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
 * Share of tails that write a comma before the postcode; a bare number alone in a later comma segment
 * appears nowhere else in the mixture, so this is the only counter-evidence for that segment.
 */
const COMMA_POSTCODE_WEIGHT = 0.15

const tail = (random: () => number, loc: string, reg: string, pc: string): string => {
	if (!pc) return `${loc}, ${reg}`

	return random() < COMMA_POSTCODE_WEIGHT ? `${loc}, ${reg}, ${pc}` : `${loc}, ${reg} ${pc}`
}

/**
 * The identifier inside a rendered unit, or `undefined` when a standalone designator
 * or a letter-only id has none.
 */
function unitIdentifier(unit: string): string | undefined {
	const last = unit.replace(/^#\s*/, "").split(/\s+/).at(-1)

	return last && /\d/.test(last) ? last : undefined
}

// `full-comma-bare` writes the identifier with no designator at all, the one unit surface carrying no
// token that decides its reading, so it is the smallest share and confined to the comma layout.
const FULL_AFTER_CUTOFF = 0.26
const FULL_COMMA_CUTOFF = 0.31
const FULL_COMMA_BARE_CUTOFF = 0.34
const FULL_FIRST_CUTOFF = 0.52
const BARE_AFTER_CUTOFF = 0.68
const BARE_FIRST_CUTOFF = 0.84

/**
 * Render a unit row in a random layout, spreading units across positions
 * and varying the surrounding surface.
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
 * Recipe registered with the corpus builder.
 */
export const unitRecipe: CorpusRecipe = {
	name: "unit",
	description: "US secondary-unit rows (#451): real OA skeletons + injected USPS Pub-28 C2 unit designators",
	mode: "generate",
	options: [{ flag: "--golden", description: "Emit the held-out VT eval set ({raw, components, country})" }],
	async run(opts, write) {
		if (opts.count == null) throw new Error("unit recipe requires --count <N>")
		const count = opts.count
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

			write(
				stringifyJSON({
					...aligned.row,
					recipe: "unit",
					base_source_id: null,
					register: requireRegister(opts, "unit"),
					surface: SurfaceOrigin.Composed,
				})
			)

			emitted++
		}

		return { emitted, skipped }
	},
}

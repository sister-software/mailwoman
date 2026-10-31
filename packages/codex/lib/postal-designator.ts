/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shared concept list and row shape for the words an address uses to mark a part of itself: a delivery
 *   service (`BP`, `Postfach`, `私書箱`), a premise (`Bâtiment`, `корпус`), a sub-premise (`APT`, `号室`), a
 *   floor (`12/F`, `층`), a number mark (`№`, `2º`), or, in a query, the relation between a thing and a place
 *   (`near`, `près de`, `300 metros norte de`).
 *
 *   Each country keeps its own table under `lib/<cc>/designators.ts`, because the same spelling means
 *   different things in different countries: `CP` is a Swiss case postale and an Italian casella postale,
 *   and `BP` is a French boîte postale. A spelling two countries share gets one row in each country's
 *   table, and {@linkcode designatorCollisions} reports where their concepts differ.
 *
 *   A row records the evidence the decoder and lexicon read. It never instructs a pass to strip a word: the
 *   same words are parts of names (`Near Sawrey`, `In der Au`, `Barrow-in-Furness`).
 */

import type { LevelDesignatorKind, LevelDesignatorRow } from "#level-semantics"

/**
 * The concepts a designator maps to, grouped by class.
 */
export const DesignatorConcept = {
	// Delivery services: mail held or routed at the post office rather than delivered to a door.
	PostOfficeBox: "post_office_box",
	PosteRestante: "poste_restante",
	SpecialRouting: "special_routing",
	PrivateBag: "private_bag",
	RuralRoute: "rural_route",
	// Premise: the building or part of a building the address identifies.
	Building: "building",
	Block: "block",
	Tower: "tower",
	Entrance: "entrance",
	Staircase: "staircase",
	// Sub-premise: a unit inside the premise.
	Apartment: "apartment",
	Suite: "suite",
	Room: "room",
	Office: "office",
	Door: "door",
	Unit: "unit",
	// Vertical position.
	Floor: "floor",
	GroundFloor: "ground_floor",
	Basement: "basement",
	Mezzanine: "mezzanine",
	Rooftop: "rooftop",
	Penthouse: "penthouse",
	// Number marks: a character or word that introduces or qualifies a number.
	NumberSign: "number_sign",
	OrdinalMark: "ordinal_mark",
	BlockNumbering: "block_numbering",
	// Relation words in a query, between the thing asked for and a place or the asker.
	Near: "near",
	NearAsker: "near_asker",
	In: "in",
	At: "at",
	On: "on",
	Beside: "beside",
	Opposite: "opposite",
	// The parts of a landmark-relative locator such as `300 metros norte del parque`.
	Direction: "direction",
	DistanceUnit: "distance_unit",
	Side: "side",
} as const

export type DesignatorConcept = (typeof DesignatorConcept)[keyof typeof DesignatorConcept]

/**
 * The class each concept belongs to.
 */
export const DESIGNATOR_CLASS = {
	post_office_box: "delivery",
	poste_restante: "delivery",
	special_routing: "delivery",
	private_bag: "delivery",
	rural_route: "delivery",
	building: "premise",
	block: "premise",
	tower: "premise",
	entrance: "premise",
	staircase: "premise",
	apartment: "sub_premise",
	suite: "sub_premise",
	room: "sub_premise",
	office: "sub_premise",
	door: "sub_premise",
	unit: "sub_premise",
	floor: "vertical",
	ground_floor: "vertical",
	basement: "vertical",
	mezzanine: "vertical",
	rooftop: "vertical",
	penthouse: "vertical",
	number_sign: "number_mark",
	ordinal_mark: "number_mark",
	block_numbering: "number_mark",
	near: "relation",
	near_asker: "relation",
	in: "relation",
	at: "relation",
	on: "relation",
	beside: "relation",
	opposite: "relation",
	direction: "locator",
	distance_unit: "locator",
	side: "locator",
} as const satisfies Record<DesignatorConcept, string>

export type DesignatorClass = (typeof DESIGNATOR_CLASS)[DesignatorConcept]

/**
 * Where a designator sits relative to the value it marks.
 *
 * - `prefix`: before the value, as in `APT 4` and `Postfach 1234`.
 * - `suffix`: after the value, as in `305号室` and `12/F`.
 * - `infix`: between two values, as the hyphen in Singapore's `#12-04` separates floor from unit.
 * - `standalone`: marks no value, as in `Poste restante` and `near me`.
 */
export type DesignatorPosition = "prefix" | "suffix" | "infix" | "standalone"

/**
 * One designator in one country's table.
 */
export interface PostalDesignatorRow {
	/**
	 * The spelling as the postal operator writes it, with its accents and script.
	 */
	spelling: string
	/**
	 * Other written forms: abbreviations, ASCII-folded spellings and variants with or without periods.
	 */
	abbreviations: readonly string[]
	/**
	 * The ISO 15924 code of the spelling's script, such as `Latn`, `Cyrl`, `Arab`, `Hebr`, `Hani` or `Kore`.
	 */
	script: string
	position: DesignatorPosition
	concept: DesignatorConcept
	/**
	 * The ISO 639 code of the language the spelling belongs to, where a country uses several.
	 */
	language: string
	/**
	 * The published list the row was checked against, as a URL or a document title.
	 */
	source: string
}

/**
 * A country's designator table.
 */
export interface PostalDesignatorTable {
	/**
	 * The ISO 3166-1 alpha-2 code of the country whose postal operator uses these designators.
	 */
	country: string
	rows: readonly PostalDesignatorRow[]
}

const LEVEL_KIND_CONCEPT = {
	ground: "ground_floor",
	basement: "basement",
	numbered: "floor",
	fractionalAboveGround: "mezzanine",
	fractionalBelowGround: "basement",
	special: "floor",
	fixedOrdinal: "floor",
} as const satisfies Record<LevelDesignatorKind, DesignatorConcept>

const LEVEL_CODE_CONCEPT: Readonly<Record<string, DesignatorConcept>> = {
	PENTHOUSE: "penthouse",
	ROOF: "rooftop",
	RF: "rooftop",
}

/**
 * Projects a language family's floor designators from `level-semantics.ts` into designator rows,
 * so a country table reads its floors from the one floor lexicon rather than repeating them.
 *
 * A row's concept follows its level kind.
 * Penthouse and roof rows have kind `special` and map to `penthouse` and `rooftop`.
 * and every other `special` row, such as the German Dachgeschoss, maps to `floor`.
 */
export function designatorRowsFromLevels(
	levels: readonly LevelDesignatorRow[],
	context: Pick<PostalDesignatorRow, "script" | "language" | "source"> & { position?: DesignatorPosition }
): PostalDesignatorRow[] {
	return levels.map((level) => ({
		spelling: level.code,
		abbreviations: level.variants.filter((variant) => variant !== level.code),
		script: context.script,
		position: context.position ?? "prefix",
		concept: LEVEL_CODE_CONCEPT[level.code] ?? LEVEL_KIND_CONCEPT[level.kind],
		language: context.language,
		source: context.source,
	}))
}

/**
 * The class of a row's concept.
 */
export function designatorClass(row: Pick<PostalDesignatorRow, "concept">): DesignatorClass {
	return DESIGNATOR_CLASS[row.concept]
}

/**
 * Folds a spelling for comparison: uppercase, without periods, with runs of whitespace as one space.
 */
export function foldDesignatorSpelling(spelling: string): string {
	return spelling.toUpperCase().replaceAll(".", "").replaceAll(/\s+/gu, " ").trim()
}

/**
 * One spelling that two or more countries use for different concepts.
 */
export interface DesignatorCollision {
	spelling: string
	readings: Array<{ country: string; concept: DesignatorConcept }>
}

/**
 * Reports each folded spelling that the tables map to more than one concept, with every reading.
 */
export function designatorCollisions(tables: readonly PostalDesignatorTable[]): DesignatorCollision[] {
	const readings = new Map<string, Map<string, { country: string; concept: DesignatorConcept }>>()

	for (const table of tables) {
		for (const row of table.rows) {
			for (const spelling of [row.spelling, ...row.abbreviations]) {
				const key = foldDesignatorSpelling(spelling)
				const byReading = readings.get(key) ?? new Map()

				byReading.set(`${table.country}/${row.concept}`, { country: table.country, concept: row.concept })
				readings.set(key, byReading)
			}
		}
	}

	return [...readings]
		.filter(([, byReading]) => new Set([...byReading.values()].map((r) => r.concept)).size > 1)
		.map(([spelling, byReading]) => ({ spelling, readings: [...byReading.values()] }))
		.toSorted((a, b) => a.spelling.localeCompare(b.spelling))
}

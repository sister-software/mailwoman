// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reads the parts of an Indian street line written as one comma-separated field.
 *
 * A publisher that holds an Indian address as one free-text line
 * writes it in the order India Post's UPU description shows
 * (`https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/indEn.pdf`, 01/2013).
 * The premise and the street come first, then the sub-localities from smallest to largest.
 *
 * Its examples are `4, Amrita Shergill Road`, `32/1, 2nd Main Road / 8th Block / Jayanagar`
 * and `Flat 408, Tagore Road Hostel / Tagore Road`.
 *
 * {@linkcode segmentINStreetLine} labels a line only where every part it keeps has one reading:
 * the premise number, a building name before the street, the street, and one sub-locality after it.
 * Door, floor and shop designators and landmark phrases (`Near`, `Opp.`) are left out.
 *
 * The IN layout has no slot that prints them where the line wrote them.
 * Any other part refuses the line.
 */

import { foldName as fold } from "@mailwoman/codex/names/normalize"

/**
 * The words that end an Indian thoroughfare's name, as the line writes them, folded to lower case.
 *
 * The English forms are libpostal's `en/street_types.txt` entries for road,
 * street, lane, avenue, highway, bypass, cross and path, without the one-
 * and two-letter forms (`r`, `l`, `la`) that end other words too.
 * `marg` is libpostal's `hi/street_types.txt`.
 *
 * `main` (Bengaluru's `2nd Main Road` is also written `2nd Main`), `salai` (Tamil, as in `Anna Salai`)
 * and `gali` (Hindi) are added here. libpostal's Hindi list also holds `nagar` and `bazar`.
 * In Indian addresses those words end a neighborhood's name rather than a street's,
 * so the table leaves them out.
 */
const THOROUGHFARE_WORDS: ReadonlySet<string> = new Set([
	"road",
	"rd",
	"roa",
	"street",
	"st",
	"str",
	"lane",
	"ln",
	"avenue",
	"ave",
	"highway",
	"hwy",
	"bypass",
	"byepass",
	"cross",
	"path",
	"marg",
	"main",
	"salai",
	"gali",
	"galli",
])

/**
 * The words that end a building or complex name, folded to lower case.
 *
 * The UPU description writes `Astro High Complex` and `Tagore Road Hostel`,
 * and street lines write `Tower`, `Plaza` and `Bhavan`.
 * A part before the street is read as a building only when it ends in one of them.
 *
 * Lines also write a village or a neighborhood there (`Kurumassery, Angamaly Road`).
 * No word of such a part tells it from a building.
 */
const BUILDING_WORDS: ReadonlySet<string> = new Set([
	"apartment",
	"apartments",
	"arcade",
	"bhavan",
	"bhawan",
	"building",
	"buildings",
	"centre",
	"center",
	"chambers",
	"complex",
	"court",
	"heights",
	"hostel",
	"house",
	"mall",
	"mansion",
	"plaza",
	"residency",
	"tower",
	"towers",
])

/**
 * The fewest words a street or a building name holds, so a bare `Road` or `Complex` is neither.
 */
const MIN_NAME_WORDS = 2

/**
 * A national or state highway written by its number, `NH 17` or `SH-4`.
 */
const NUMBERED_HIGHWAY = /^(?:NH|SH)[\s-]?\d+[A-Z]?$/i

/**
 * A premise number, optionally after the label a line writes before it
 * (`No.`, `Door No`, `Plot No`, `H.No`, `#`).
 *
 * The number is digits, optionally with a slash, a hyphen or a letter
 * (`32/1`, `21/5794`, `2/A1`, `49-1`, `5B`).
 * Group 1 is the number without the label.
 */
const PREMISE_NUMBER =
	/^(?:(?:no|door\s*no|d\.?\s*no|plot\s*no|h\.?\s*no|house\s*no|#)\.?\s*)?(\d+[A-Za-z]?(?:\s?[/-]\s?[0-9A-Za-z]{1,6}){0,2})$/i

/**
 * A street part that opens with its premise number: `No 14 Muthuvelapa Street`, `318 DB Road`.
 *
 * Group 1 is the number and group 2 the street.
 * A number followed by a measure belongs to the street's name (`100 Ft. Road`), so it isn't split off.
 */
const NUMBER_THEN_STREET =
	/^(?:(?:no|door\s*no|plot\s*no|h\.?\s*no|#)\.?\s*)?(\d+[A-Za-z]?(?:[/-][0-9A-Za-z]{1,6})?)\s+(?!(?:ft|feet|km|kms|mtrs?|met(?:er|re)s?)\b)(\S.*)$/i

/**
 * A door, floor, shop or flat designator: `Ground Floor`, `1st Floor`, `Gr Flr`, `Shop No 70`, `Flat 408`.
 */
const DESIGNATOR =
	/^(?:(?:ground|gr\.?|grd\.?|upper|lower|first|second|third|fourth|fifth|top|\d+(?:st|nd|rd|th)?)\s*(?:floor|flr)\b|(?:shop|flat|office|unit|suite|room|stall|apartment|apt|door)\b)/i

/**
 * A landmark phrase.
 *
 * It places the premise beside something else rather than giving its address.
 */
const LANDMARK =
	/^(?:opp|opposite|near|nr|behind|beside|besides|next\s+to|adjacent|adj|in\s+front\s+of|off|above|inside)\b/i

/**
 * A landmark phrase inside a part, as in `318 DB Road Near Axis Bank`, which no one split of the part reads.
 */
const LANDMARK_INSIDE = /\s(?:opp|opposite|near|nr|behind|beside)\.?\s/i

/**
 * A sub-province or post-office designator: a district, taluk or tehsil,
 * a hobli or mandal, or a post office.
 *
 * The UPU description writes these on their own lines (`Pennukonda Taluk / Anantpur District`).
 * The IN layout has no slot for them, so a line that holds one is refused.
 */
const SUB_PROVINCE =
	/\b(?:dist|distt|district|sub-district|taluk|taluka|tehsil|tahsil|hobli|mandal|block|post|p\.?\s?o)\b\.?/i

/**
 * A census sub-district numbered in Roman numerals, `Purulia-II`.
 */
const NUMBERED_SUB_DISTRICT = /[\s-](?:I|II|III|IV|V|VI)$/u

/**
 * Whether a value is a district, taluk, tehsil, hobli, mandal or post office,
 * or a census sub-district numbered in Roman numerals, rather than a locality or a street.
 */
export function isINSubProvince(value: string): boolean {
	return SUB_PROVINCE.test(value) || NUMBERED_SUB_DISTRICT.test(value.trim())
}

/**
 * A sub-locality as a line writes it after the street: a name of letters, at least three of them, with
 * the spaces, dots, hyphens and apostrophes a name holds (`Jayanagar`, `R.S. Puram`, `Kalyan Nagar`).
 */
const SUB_LOCALITY = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{2,}$/u

/**
 * The numbers a street's name holds: an ordinal (`2nd Main Road`), a numbered highway (`NH 17`),
 * a measure (`100 Ft. Road`, `12th KM`) and a sector, phase or stage (`Sector 11 Road`).
 */
const NUMBER_IN_STREET_NAME =
	/\b\d+(?:st|nd|rd|th)\b|\b(?:NH|SH)[\s-]?\d+[A-Z]?\b|\b\d+\s*(?:ft|feet|km|kms|mtrs?|met(?:er|re)s?)\b|\b(?:sector|phase|stage)[\s-]?\d+[A-Z]?\b/giu

/**
 * Whether a street holds a digit its name doesn't account for,
 * as `MORARJEE VELJEE BLDGR 16 KOLBHAT LANE` holds a building's number.
 */
function streetHoldsNumber(street: string): boolean {
	return /\d/u.test(street.replaceAll(NUMBER_IN_STREET_NAME, ""))
}

/**
 * A PIN code written into the street line: six digits, with an optional space after the third.
 */
const PIN_IN_LINE = /(?<!\d)\d{3}\s?\d{3}(?!\d)/u

/**
 * Why a line was not labeled.
 */
export const INStreetLineRefusal = {
	/**
	 * The line is empty once the parts that repeat the locality or the state are removed.
	 */
	Empty: "empty",
	/**
	 * The line writes a six-digit number: the PIN code, written into the street line.
	 */
	PostcodeInLine: "postcode-in-line",
	/**
	 * The line holds a district, taluk, tehsil, hobli, mandal or post office.
	 */
	SubProvinceInLine: "sub-province-in-line",
	/**
	 * A landmark phrase sits inside a part rather than in a part of its own.
	 */
	LandmarkInsidePart: "landmark-inside-part",
	/**
	 * No part ends in a thoroughfare word.
	 */
	NoThoroughfare: "no-thoroughfare",
	/**
	 * More than one part before the street remains once designators and the premise number are
	 * removed, or the one that remains isn't a building name (`RS No 514/4`, a village name).
	 */
	PremiseUnread: "premise-unread",
	/**
	 * The street holds a digit its name doesn't account for, such as a building's number inside it.
	 */
	StreetHoldsNumber: "street-holds-number",
	/**
	 * More than one part follows the street, or the part that does isn't a name of three letters or more.
	 */
	SubLocalityUnread: "sub-locality-unread",
} as const

export type INStreetLineRefusal = (typeof INStreetLineRefusal)[keyof typeof INStreetLineRefusal]

/**
 * The parts of an Indian street line, labeled.
 */
export interface INStreetLineParts {
	house_number?: string
	/**
	 * A building or complex name written before the street, as `Tagore Road Hostel` is in the UPU description.
	 */
	venue?: string
	street: string
	dependent_locality?: string
	/**
	 * The count of designator and landmark parts left out.
	 */
	omitted: number
}

/**
 * The fields of the record beside the line.
 * A line may repeat their values.
 */
export interface INStreetLineContext {
	locality?: string | null
	region?: string | null
}

/**
 * A part's words in lower case, with the punctuation at either end of each word removed (`Rd.` → `rd`).
 */
function foldedWords(part: string): string[] {
	return part
		.toLowerCase()
		.split(/\s+/u)
		.map((word) => word.replaceAll(/^[\p{P}]+|[\p{P}]+$/gu, ""))
		.filter((word) => word.length > 0)
}

/**
 * Whether a part is a street: its last word is a thoroughfare word, or it is a numbered highway.
 */
function isINThoroughfare(part: string): boolean {
	if (NUMBERED_HIGHWAY.test(part.trim())) return true

	const words = foldedWords(part)

	return words.length >= MIN_NAME_WORDS && THOROUGHFARE_WORDS.has(words.at(-1)!)
}

/**
 * Whether a part is a building's name: its last word a building word, and no digit.
 */
function isINBuilding(part: string): boolean {
	const words = foldedWords(part)

	return words.length >= MIN_NAME_WORDS && BUILDING_WORDS.has(words.at(-1)!) && !/\d/u.test(part)
}

/**
 * Label the parts of an Indian street line, or return the reason it can't be labeled.
 */
export function segmentINStreetLine(
	line: string,
	context: INStreetLineContext = {}
): INStreetLineParts | { refused: INStreetLineRefusal } {
	const echoes = new Set(
		[context.locality, context.region].filter((value) => value?.trim()).map((value) => fold(value!))
	)

	const parts = line
		.replaceAll(/\s+/gu, " ")
		.split(/\s*,\s*/u)
		.map((part) => part.trim().replace(/[.;:-]+$/u, ""))
		.filter((part) => part.length > 0 && !echoes.has(fold(part)))

	if (!parts.length) return { refused: INStreetLineRefusal.Empty }

	if (parts.some((part) => PIN_IN_LINE.test(part))) return { refused: INStreetLineRefusal.PostcodeInLine }

	if (parts.some(isINSubProvince)) return { refused: INStreetLineRefusal.SubProvinceInLine }

	if (parts.some((part) => LANDMARK_INSIDE.test(` ${part} `) && !LANDMARK.test(part))) {
		return { refused: INStreetLineRefusal.LandmarkInsidePart }
	}

	let omitted = 0
	const kept: string[] = []

	for (const part of parts) {
		if (DESIGNATOR.test(part) || LANDMARK.test(part)) {
			omitted++
		} else {
			kept.push(part)
		}
	}

	const streetAt = kept.findIndex(isINThoroughfare)

	if (streetAt === -1) return { refused: INStreetLineRefusal.NoThoroughfare }

	let street = kept[streetAt]!
	let houseNumber: string | undefined
	const before = kept.slice(0, streetAt)
	const after = kept.slice(streetAt + 1)
	const leading = NUMBER_THEN_STREET.exec(street)

	if (leading && isINThoroughfare(leading[2]!)) {
		houseNumber = leading[1]!
		street = leading[2]!
	} else {
		// The premise number may stand before a building name (`No. 484/2, Rithvi Tower, Perundurai Rd`).
		const at = before.findLastIndex((part) => PREMISE_NUMBER.test(part))

		if (at !== -1) {
			houseNumber = PREMISE_NUMBER.exec(before[at]!)![1]!
			before.splice(at, 1)
		}
	}

	if (streetHoldsNumber(street)) return { refused: INStreetLineRefusal.StreetHoldsNumber }

	if (before.length > 1 || (before.length === 1 && !isINBuilding(before[0]!))) {
		return { refused: INStreetLineRefusal.PremiseUnread }
	}

	if (after.length > 1 || (after.length === 1 && !SUB_LOCALITY.test(after[0]!))) {
		return { refused: INStreetLineRefusal.SubLocalityUnread }
	}

	return {
		...(houseNumber ? { house_number: houseNumber.replaceAll(/\s+/gu, "") } : {}),
		...(before.length ? { venue: before[0]! } : {}),
		street,
		...(after.length ? { dependent_locality: after[0]! } : {}),
		omitted,
	}
}

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The written street-type word for a FINESS `typvoie` code, and the test for a street name whose
 * digits belong to the name.
 *
 * ## Where the codes come from
 *
 * FINESS codes `typvoie` against the Agence du Numérique en Santé's terminology TRE-R35 `TypeVoie`,
 * published in the Nomenclatures des Objets de Santé at
 * `https://mos.esante.gouv.fr/NOS/TRE_R35-TypeVoie/FHIR/TRE-R35-TypeVoie` and as FHIR JSON at
 * `https://ansforge.github.io/IG-terminologie-de-sante/ig/main/CodeSystem-TRE-R35-TypeVoie.json`.
 * The list holds 170 codes, each one to four capital letters as the FINESS schema's "typeTypeVoie"
 * pattern `[A-Z]{1,4}` requires. Every code the overseas rows of the 2026-05-04 extract use is in it.
 *
 * {@linkcode expandFinessVoieType} reads the codex's `FR_VOIE_TYPES` in reverse first, mapping each
 * abbreviation and each canonical word back to its canonical word, so `R` reads `rue` and `AV`
 * reads `avenue`. {@linkcode TRE_R35_VOIE_TYPES} then supplies the codes that table does not hold,
 * transcribed from TRE-R35, and the one code where the two disagree: TRE-R35 writes `PASS` for
 * `passe`, where `FR_VOIE_TYPES` lists `pass` as an abbreviation of `passage`. The publisher's list
 * decides that code, so the local table is consulted before the reverse lookup.
 */

import { FR_VOIE_TYPES, type FrenchVoieType, isFrenchStreetWord } from "@mailwoman/codex/fr/voie"
import { foldToken } from "@mailwoman/codex/normalize"

import { decomposeFrStreet } from "#fr/street-decompose"

/**
 * TRE-R35 codes that `FR_VOIE_TYPES` does not resolve, or resolves to another word,
 * with the word an address writes for each.
 *
 * Five zone codes keep their acronym, because the acronym is the written form:
 * an address reads `ZAC DE MOUDONG` rather than `Zone d'aménagement concerté de Moudong`,
 * and TRE-R35's own display for `HLM` is the acronym.
 *
 * `LD` maps to `null`.
 * A lieu-dit is written by its name alone, so the code adds no word to the line.
 *
 * `VAL` keeps the code as its word.
 * TRE-R35 displays it as `Vallée, vallon`, two words the code does not choose between,
 * and `Val` is itself the written word of many French place names.
 */
export const TRE_R35_VOIE_TYPES: Readonly<Record<string, string | null>> = {
	ANSE: "anse",
	ART: "ancienne route",
	BRG: "bourg",
	CAR: "carrefour",
	CCAL: "centre commercial",
	CHEM: "cheminement",
	CHS: "chaussée",
	CTRE: "centre",
	EN: "enceinte",
	ESP: "esplanade",
	ESPA: "espace",
	GR: "grande rue",
	HLM: "HLM",
	IMM: "immeuble",
	JARD: "jardin",
	LD: null,
	MTE: "montée",
	PARC: "parc",
	PASS: "passe",
	PAT: "patio",
	PKG: "parking",
	PLAG: "plage",
	QU: "quai",
	QUA: "quartier",
	RLE: "ruelle",
	ROC: "rocade",
	TRA: "traverse",
	VAL: "val",
	VGE: "village",
	VLA: "villa",
	VLGE: "village",
	VOI: "voie",
	ZA: "ZA",
	ZAC: "ZAC",
	ZI: "ZI",
	ZONE: "zone",
	ZUP: "ZUP",
}

/**
 * The code that TRE-R35 gives a care-of line, `Chez`.
 * Such a line gives the person whose premises the address is.
 */
export const CARE_OF_VOIE_TYPE = "CHEZ"

/**
 * Each folded abbreviation and canonical word in `FR_VOIE_TYPES`, mapped to its canonical word.
 */
const FR_VOIE_WORD_BY_TOKEN: ReadonlyMap<string, string> = (() => {
	const out = new Map<string, string>()

	for (const canonical of Object.keys(FR_VOIE_TYPES) as FrenchVoieType[]) {
		out.set(foldToken(canonical), canonical)

		for (const abbreviation of FR_VOIE_TYPES[canonical]) {
			out.set(foldToken(abbreviation), canonical)
		}
	}

	return out
})()

/**
 * The street-type word for a `typvoie` code, in lower case as the codex writes it.
 *
 * Returns `null` for a code that adds no word (`LD`) and `undefined` for a code neither
 * table resolves, so a caller can refuse a code it cannot read rather than print the code.
 */
export function expandFinessVoieType(code: string): string | null | undefined {
	const trimmed = code.trim().toUpperCase()

	if (!trimmed) return null

	if (Object.hasOwn(TRE_R35_VOIE_TYPES, trimmed)) return TRE_R35_VOIE_TYPES[trimmed]

	return FR_VOIE_WORD_BY_TOKEN.get(foldToken(trimmed))
}

/**
 * TRE-R35's one-word street types, folded, for the words the BAN reader's dictionary does not hold.
 */
const TRE_R35_WORDS: ReadonlySet<string> = new Set(
	Object.values(TRE_R35_VOIE_TYPES)
		.filter((word): word is string => word !== null && !word.includes(" "))
		.map((word) => foldToken(word))
)

/**
 * A street line split into its leading type word and the name after it.
 */
export interface FrenchStreetSplit {
	street_prefix: string
	street: string
}

/**
 * Split a written street into its leading type word and its name, or return `null`
 * where the first word is not a street type.
 *
 * The BAN reader's {@linkcode decomposeFrStreet} is consulted first, then TRE-R35's words and the
 * codex's `FR_VOIE_TYPES`, which hold the overseas types it lacks (`quartier`, `lotissement`, `ZAC`).
 * The name may come back empty, as it does for a line reading `Rue` alone.
 */
export function splitFrenchStreetType(line: string): FrenchStreetSplit | null {
	const decomposed = decomposeFrStreet(line)
	const [first = "", ...rest] = line.split(" ")

	// The dictionary reads `route nationale` as one type word.
	// That split leaves the route number by itself as the street name.
	// Here the type is the first word, and the name keeps `nationale 2`.
	if (decomposed.prefix && /^\d+[a-z]?$/iu.test(decomposed.street)) {
		return { street_prefix: first, street: rest.join(" ") }
	}

	if (decomposed.prefix) return { street_prefix: decomposed.prefix, street: decomposed.street }

	if (TRE_R35_WORDS.has(foldToken(first).replace(/\.$/u, "")) || isFrenchStreetWord(first)) {
		return { street_prefix: first, street: rest.join(" ") }
	}

	return null
}

/**
 * The French month names, folded, which a date-named street writes after its day.
 */
const MONTHS = "janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre"

/**
 * Street names whose digits are part of the name rather than a house number or a building.
 *
 * A numbered route (`NATIONALE 2`, `DEPARTEMENTAL 5`, `RN1`, `CD 11`, `route Nationale 2`)
 * and a date (`DU 22 MAI`, `DU 8 MAI 1945`) are both names: a publisher that stores the
 * house number in its own field leaves these digits in the street because they belong to it.
 */
const NUMBERED_NAMES: readonly RegExp[] = [
	/^(?:(?:route|rte|chemin|che|ch) )?(?:(?:de la|du) )?(?:nationale|departementale?|communale|rn|rd|cd|n|d) ?(?:n° ?|n ?)?\d+[a-z]?$/u,
	new RegExp(`^(?:du |des )?\\d{1,2}(?:er)? (?:${MONTHS})(?: \\d{4})?$`, "u"),
]

/**
 * Whether the digits in a street name belong to the name.
 *
 * A name with no digit is not in question and returns `true`.
 * A name such as `VALLÉE 3 BP 208` or `DIAKA BAT A4 PORTE 2` returns `false`, which is the
 * case a reader refuses rather than print a box or a door number as part of a street.
 */
export function isStreetNameDigitPlaced(name: string): boolean {
	if (!/\d/u.test(name)) return true

	const folded = foldToken(name).replaceAll(/\s+/gu, " ").trim()

	return NUMBERED_NAMES.some((pattern) => pattern.test(folded))
}

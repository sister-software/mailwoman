/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-locale street abbreviation tables for en-US, fr-FR, es-ES and the locale-unknown geocode path.
 */

interface AbbreviationEntry {
	/**
	 * The short form, matched case-insensitively.
	 */
	from: string
	/**
	 * The canonical long form.
	 */
	to: string
}

const EN_US_DICT: ReadonlyArray<AbbreviationEntry> = [
	{ from: "N", to: "North" },
	{ from: "S", to: "South" },
	{ from: "E", to: "East" },
	{ from: "W", to: "West" },
	{ from: "NE", to: "Northeast" },
	{ from: "NW", to: "Northwest" },
	{ from: "SE", to: "Southeast" },
	{ from: "SW", to: "Southwest" },

	{ from: "St", to: "Street" },
	{ from: "Ave", to: "Avenue" },
	{ from: "Blvd", to: "Boulevard" },
	{ from: "Rd", to: "Road" },
	{ from: "Dr", to: "Drive" },
	{ from: "Ct", to: "Court" },
	{ from: "Ln", to: "Lane" },
	{ from: "Pl", to: "Place" },
	{ from: "Pkwy", to: "Parkway" },
	{ from: "Hwy", to: "Highway" },
	{ from: "Sq", to: "Square" },
	{ from: "Ter", to: "Terrace" },
]

const FR_FR_DICT: ReadonlyArray<AbbreviationEntry> = [
	{ from: "R", to: "Rue" },
	{ from: "Bd", to: "Boulevard" },
	{ from: "Av", to: "Avenue" },
	{ from: "Bvd", to: "Boulevard" },
	{ from: "Pl", to: "Place" },
	{ from: "Imp", to: "Impasse" },
	{ from: "Sq", to: "Square" },
]

/**
 * `Av` reads Avenue in French and Avenida in Spanish, so the Spanish entries cannot join a shared set.
 */
const ES_ES_DICT: ReadonlyArray<AbbreviationEntry> = [
	{ from: "Av", to: "Avenida" },
	{ from: "Avda", to: "Avenida" },
	{ from: "Avd", to: "Avenida" },
]

/**
 * Entries safe to apply before the input's locale is known.
 *
 * Each entry is multi-character and collision-free across locale tables.
 *
 * `Av` is a known exception whose removal needs a resolver-gauntlet measurement.
 */
const LOCALE_UNKNOWN_DICT: ReadonlyArray<AbbreviationEntry> = [
	{ from: "Bd", to: "Boulevard" },
	{ from: "Bvd", to: "Boulevard" },
	{ from: "Boul", to: "Boulevard" },
	{ from: "Av", to: "Avenue" },
	{ from: "Imp", to: "Impasse" },
]

/**
 * The abbreviation table for a locale, where `und` selects the locale-unknown set
 * and an unrecognized value selects en-US.
 */
export function abbreviationDictionary(locale?: string): ReadonlyArray<AbbreviationEntry> {
	const lc = (locale ?? "en-US").toLowerCase()

	if (lc === "und") return LOCALE_UNKNOWN_DICT

	if (lc.startsWith("fr")) return FR_FR_DICT

	if (lc.startsWith("es")) return ES_ES_DICT

	return EN_US_DICT
}

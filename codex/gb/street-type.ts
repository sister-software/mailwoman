/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   British street vocabulary (thoroughfare types).
 *
 *   The contrast across the codex's street files is structural. A US street type is a trailing word
 *   with a USPS-standardized abbreviation (`Main Street` → `ST`). A German street type is a fused
 *   agglutinative suffix (`Hauptstraße`). A French type is a leading standalone word (`Rue de la
 *   Paix`). British practice is the US shape — a separate TRAILING word — but with a notably RICHER
 *   and more local vocabulary: alongside the everyday `Road`/`Street`/`Avenue` sit `Crescent`,
 *   `Mews`, `Close`, `Wynd`, `Brae`, `Gait`, `Croft`, `Dene` and a long tail of landscape words
 *   (`Brook`, `Copse`, `Dell`, `Hollow`, `Spinney`) that read as thoroughfare types in the UK and
 *   essentially nowhere else.
 *
 *   So detection is, like French, a whole-token match — {@link isBritishStreetWord} asks "is this
 *   token a known British thoroughfare word" rather than testing a suffix — because these are
 *   distinct trailing words, not fused endings.
 */

/**
 * The British thoroughfare vocabulary. Lowercase canonical forms, matched as whole tokens. Spans
 * the common core (`street`, `road`, `lane`, `avenue`) through the distinctively British
 * (`crescent`, `mews`, `close`, `terrace`) and the regional/landscape tail (`wynd`, `brae`, `gait`,
 * `croft`, `dene`, `spinney`, `dell`, `hollow`).
 */
export const GB_STREET_TYPES = [
	"street",
	"road",
	"lane",
	"avenue",
	"close",
	"crescent",
	"court",
	"drive",
	"place",
	"way",
	"gardens",
	"grove",
	"terrace",
	"mews",
	"walk",
	"hill",
	"green",
	"park",
	"rise",
	"view",
	"row",
	"square",
	"parade",
	"vale",
	"wharf",
	"yard",
	"gate",
	"croft",
	"dene",
	"end",
	"fields",
	"meadow",
	"brook",
	"chase",
	"copse",
	"dale",
	"dell",
	"glen",
	"hollow",
	"paddock",
	"ridge",
	"spinney",
	"wynd",
	"brae",
	"gait",
] as const

/** A canonical British thoroughfare word (e.g. `street`, `crescent`, `mews`). */
export type BritishStreetType = (typeof GB_STREET_TYPES)[number]

const STREET_TYPE_SET: ReadonlySet<string> = new Set(GB_STREET_TYPES)

/**
 * True when a token is a British thoroughfare type word (case-insensitive, whole-token match) —
 * `Crescent`, `Mews`, `Close`, `Road`. Matches the WHOLE token, not a suffix, so an unrelated place
 * name (`Tokyo`, `Bordeaux`) is not flagged the way an `-endsWith` test might.
 */
export function isBritishStreetWord(token: unknown): boolean {
	if (typeof token !== "string") return false
	const t = token.toLowerCase().replace(/[^a-z]/g, "")
	return t.length > 0 && STREET_TYPE_SET.has(t)
}

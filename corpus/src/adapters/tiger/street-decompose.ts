/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decompose a US street name into Stage 3 components: street_prefix, street, street_suffix.
 *
 *   Examples:
 *     "N Main St" → { prefix: "N", street: "Main", suffix: "St" }
 *     "Pennsylvania Avenue NW" → { prefix: null, street: "Pennsylvania", suffix: "Avenue NW" }
 *     "Salmon St" → { prefix: null, street: "Salmon", suffix: "St" }
 *     "SE Hawthorne Blvd" → { prefix: "SE", street: "Hawthorne", suffix: "Blvd" }
 *     "5th Ave" → { prefix: null, street: "5th", suffix: "Ave" }
 *
 *   Compiled-in directional + street-type sets (subset of libpostal/en). Sufficient for
 *   TIGER FULLNAME values which use a constrained vocabulary.
 */

const DIRECTIONALS = new Set([
	"n",
	"s",
	"e",
	"w",
	"ne",
	"nw",
	"se",
	"sw",
	"north",
	"south",
	"east",
	"west",
	"northeast",
	"northwest",
	"southeast",
	"southwest",
])

const STREET_TYPES = new Set([
	"st",
	"street",
	"ave",
	"avenue",
	"blvd",
	"boulevard",
	"rd",
	"road",
	"dr",
	"drive",
	"ln",
	"lane",
	"way",
	"ct",
	"court",
	"pl",
	"place",
	"pkwy",
	"parkway",
	"ter",
	"terrace",
	"cir",
	"circle",
	"hwy",
	"highway",
	"trl",
	"trail",
	"sq",
	"square",
	"plz",
	"plaza",
	"path",
	"pike",
	"row",
	"crescent",
	"loop",
	"alley",
	"aly",
	"cv",
	"cove",
	"glen",
	"grove",
	"run",
	"walk",
	"bend",
	"point",
	"pt",
	"ridge",
	"crest",
	"crossing",
	"xing",
	"mews",
	"esplanade",
	"promenade",
	"broadway",
])

export interface DecomposedStreet {
	prefix: string | null
	street: string
	suffix: string | null
}

/**
 * Decompose a US street name into prefix/name/suffix components.
 *
 * Conservative — only emits prefix/suffix when there's a clear directional or street-type
 * keyword. Returns the original as `street` if nothing matches.
 */
export function decomposeStreet(fullname: string): DecomposedStreet {
	const trimmed = fullname.trim()
	if (!trimmed) return { prefix: null, street: "", suffix: null }

	const tokens = trimmed.split(/\s+/)
	if (tokens.length === 1) return { prefix: null, street: trimmed, suffix: null }

	let prefix: string | null = null
	let suffix: string | null = null
	let startIdx = 0
	let endIdx = tokens.length

	// Leading directional prefix
	const first = tokens[0]!.toLowerCase().replace(/\./g, "")
	if (DIRECTIONALS.has(first) && tokens.length >= 2) {
		prefix = tokens[0]!
		startIdx = 1
	}

	// Trailing post-directional (e.g. "Pennsylvania Ave NW")
	const last = tokens[endIdx - 1]!.toLowerCase().replace(/\./g, "")
	const secondLast = endIdx >= 2 ? tokens[endIdx - 2]!.toLowerCase().replace(/\./g, "") : ""

	if (DIRECTIONALS.has(last) && STREET_TYPES.has(secondLast)) {
		// "<type> <directional>" pattern → suffix = "type directional"
		suffix = tokens.slice(endIdx - 2, endIdx).join(" ")
		endIdx -= 2
	} else if (STREET_TYPES.has(last) && endIdx - startIdx >= 2) {
		suffix = tokens[endIdx - 1]!
		endIdx -= 1
	} else if (DIRECTIONALS.has(last) && endIdx - startIdx >= 2) {
		// Post-directional without type: "5th St N" handled above; "Broadway N" → suffix = "N"
		suffix = tokens[endIdx - 1]!
		endIdx -= 1
	}

	const street = tokens.slice(startIdx, endIdx).join(" ").trim()
	if (!street) {
		// All tokens consumed — degenerate case, return original
		return { prefix: null, street: trimmed, suffix: null }
	}

	return { prefix, street, suffix }
}

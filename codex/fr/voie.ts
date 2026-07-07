/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   French street types (types de voie).
 *
 *   The third point on the morphology spectrum the codex now spans:
 *
 *   - US — the type is a TRAILING word with a standardized abbreviation (`Main Street` → `ST`).
 *   - German — the type is a fused TRAILING suffix (`Hauptstraße`).
 *   - French — the type is a LEADING standalone word (`Rue de la Paix`, `Avenue des Champs-Élysées`).
 *       It carries common abbreviations (`bd`, `av`, `pl`) but no single national standard like
 *       USPS Pub-28.
 *
 *   So French detection is "is this token a known voie word", position-first — which is why
 *   {@link isFrenchStreetWord} matches a whole token rather than a suffix.
 */

/**
 * Canonical French voie type → common written abbreviations. The leading word of a French street name. The first entry
 * of each list is the most common abbreviation where one exists.
 */
export const FR_VOIE_TYPES = {
	rue: ["r"],
	avenue: ["av", "ave"],
	boulevard: ["bd", "boul"],
	place: ["pl"],
	impasse: ["imp"],
	allée: ["all"],
	allées: [],
	chemin: ["ch", "che"],
	quai: [],
	cours: ["crs"],
	passage: ["pass", "psg"],
	square: ["sq"],
	route: ["rte"],
	sentier: ["sen"],
	villa: [],
	cité: [],
	esplanade: ["espl"],
	faubourg: ["fbg", "fg"],
	mail: [],
	promenade: ["prom"],
	"rond-point": ["rpt"],
	voie: [],
	chaussée: ["chée"],
	ruelle: [],
	venelle: [],
	traverse: ["trav"],
	montée: ["mtée"],
	clos: [],
	hameau: ["ham"],
	résidence: ["rés"],
	lotissement: ["lot"],
} as const satisfies Record<string, readonly string[]>

/** A canonical French voie type (e.g. `rue`, `avenue`, `boulevard`). */
export type FrenchVoieType = keyof typeof FR_VOIE_TYPES

/**
 * Set of every French voie token — each canonical type plus each abbreviation — folded to lowercase/diacritic-free for
 * matching. `Allée`/`allee`/`all` all resolve here.
 */
const VOIE_TOKEN_SET: ReadonlySet<string> = (() => {
	const fold = (s: string): string =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
	const out = new Set<string>()

	for (const canonical of Object.keys(FR_VOIE_TYPES) as FrenchVoieType[]) {
		out.add(fold(canonical))

		for (const abbr of FR_VOIE_TYPES[canonical]) {
			out.add(fold(abbr))
		}
	}

	return out
})()

/**
 * True when a token is a French voie type word or abbreviation (case- and accent-insensitive) — `Rue`, `BD`, `Allée`,
 * `impasse`. Matches the WHOLE token (French types lead the street name, they are not fused suffixes), so a city or
 * surname is not caught the way a suffix test might.
 */
export function isFrenchStreetWord(token: unknown): boolean {
	if (typeof token !== "string") return false
	const t = token
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z-]/g, "")

	return t.length > 0 && VOIE_TOKEN_SET.has(t)
}

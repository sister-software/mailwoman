/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Organization-name canonicalization — reduce a company name to a stable, comparable key.
 *
 *   Winkler's record-linkage recipe: words of little distinguishing power (the legal designation —
 *   `Corporation`, `Limited`, `LLC`) are normalized away before matching, so `Acme Corp` and `Acme
 *   Corporation, LLC` collapse to the same key. We also split off a `doing business as` clause and
 *   normalize connectives (`&` → `and`), punctuation, accents, and a leading `The`.
 *
 *   Evidence honesty (per the name-canonicalization research pass): the PERSON-name side is well
 *   sourced; the ORGANIZATION side is a known evidence gap. This is a solid _canonicalization_
 *   baseline (the strip-designations principle is Winkler-grounded; the designation list draws on
 *   the ISO 20275 Entity Legal Forms register and `cleanco`). The harder org-_matching_ problems —
 *   acronym ↔ expansion (`IBM` ↔ `International Business Machines`), DBA/alias resolution beyond
 *   the simple clause, subsidiary/parent, and TF-IDF n-gram token matching — are deferred to a
 *   follow-up (a dedicated org-matching research pass + the matcher epic).
 */

/** A canonicalized organization name. */
export interface OrganizationName {
	/** The original input, verbatim. */
	raw: string
	/** Normalized, designation-stripped key for blocking and comparison. */
	canonical: string
	/** Legal designations that were stripped (`llc`, `inc`, `gmbh`), in encounter order. */
	designations: string[]
	/** The `doing business as` / trade-name clause, canonicalized, when one was present. */
	dba?: string
}

/**
 * Legal-entity designations across jurisdictions, normalized to lowercase with punctuation removed
 * (so `L.L.C.` → `llc`). Drawn from the ISO 20275 Entity Legal Forms register + `cleanco`'s common
 * set. Stripped as whole tokens wherever they occur. Deliberately excludes name-meaningful words
 * (`group`, `holdings`, `partners`, `associates`).
 */
const DESIGNATIONS = new Set([
	"inc",
	"incorporated",
	"corp",
	"corporation",
	"co",
	"company",
	"llc",
	"lllp",
	"llp",
	"pllc",
	"lp",
	"ltd",
	"limited",
	"plc",
	"pc",
	"pa",
	"ag",
	"sa",
	"sas",
	"sarl",
	"sl",
	"gmbh",
	"mbh",
	"ug",
	"bv",
	"nv",
	"oy",
	"oyj",
	"ab",
	"as",
	"asa",
	"spa",
	"srl",
	"kg",
	"kgaa",
	"kk",
	"pty",
	"proprietary",
	"bhd",
	"sdn",
	"cc",
	"cv",
	"ulc",
	"aps",
	"kft",
	"zrt",
	"doo",
	"ood",
	"ead",
])

/** Splits a `doing business as` / trade-name clause from a legal name. */
const DBA_PATTERN = /\s+(?:d\/b\/a|dba|doing business as|t\/a|trading as|a\/k\/a|aka|fka|f\/k\/a)\s+/i

/**
 * Canonicalize one name fragment: lowercase, strip accents, connectives → `and`, drop punctuation,
 * remove a leading `the`, strip legal designations, collapse whitespace. Returns the key plus the
 * designations it removed.
 */
function canonicalizeFragment(fragment: string): { canonical: string; designations: string[] } {
	const normalized = fragment
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		// connective punctuation joins words rather than vanishing: "AT&T" → "at and t"
		.replace(/&/g, " and ")
		.replace(/\+/g, " and ")
		// periods + apostrophes are intra-token, so remove (not space): "S.A." → "sa", "Macy's" → "macys"
		.replace(/[.'’]/g, "")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^the\s+/, "")

	const designations: string[] = []
	const kept: string[] = []
	for (const token of normalized.split(" ")) {
		if (!token) continue
		if (DESIGNATIONS.has(token)) designations.push(token)
		else kept.push(token)
	}

	return { canonical: kept.join(" "), designations }
}

/**
 * Canonicalize an organization name: split off any `doing business as` clause, then reduce the
 * legal name to a designation-stripped key. Returns `null` for empty input.
 */
export function canonicalizeOrganizationName(input: string | null | undefined): OrganizationName | null {
	if (typeof input !== "string" || !input.trim()) return null

	const raw = input
	const [legalPart, ...dbaParts] = input.split(DBA_PATTERN)

	const { canonical, designations } = canonicalizeFragment(legalPart ?? "")

	const result: OrganizationName = { raw, canonical, designations }

	if (dbaParts.length) {
		const dba = canonicalizeFragment(dbaParts.join(" ")).canonical
		if (dba) result.dba = dba
	}

	return result
}

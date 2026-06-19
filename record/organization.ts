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
 *   **The collision problem (#668).** A legal-form token in one jurisdiction is a meaningful word in
 *   another domain. `PT` is Indonesia's `Perseroan Terbatas` (its LLC) — and US-healthcare
 *   shorthand for _Physical Therapy_. `SCA` / `SCS` are French/Belgian/Luxembourg commandite forms
 *   — and, in a clinic's name, _Sudden Cardiac Arrest_ / _Spinal Cord Stimulator_. A single
 *   universal strip-list can't be right for both: strip `PT` and you corrupt `Lakeside PT`; keep it
 *   and you leave the legal form on an Indonesian company. So the strip-set is computed on **two
 *   axes**:
 *
 *   - **jurisdiction** (ISO 3166-1 alpha-2, e.g. from the resolved address country) — _adds_ the legal
 *       forms valid in that country. Collision-prone forms (`pt`, `sca`, `scs`) live here, gated
 *       behind a known jurisdiction, NOT in the universal base.
 *   - **domain** (an ingest-config tag, e.g. `healthcare`) — _protects_ domain-meaningful tokens from
 *       ever being stripped, even when a jurisdiction pack would add them. Domain protection wins.
 *
 *   `effective = (base ∪ jurisdiction-pack) − domain-protect-pack`. With no options the set is the
 *   universal base and behavior is byte-for-byte unchanged — the new axes are strictly opt-in.
 *
 *   Evidence honesty (per the name-canonicalization research pass): the PERSON-name side is well
 *   sourced; the ORGANIZATION side is a known evidence gap. This is a solid _canonicalization_
 *   baseline (the strip-designations principle is Winkler-grounded; the designation list draws on
 *   the ISO 20275 Entity Legal Forms register and `cleanco`). The jurisdiction/domain packs below
 *   are grounded seeds, not exhaustive — extend them per ISO 20275 as locales are added. The harder
 *   org-_matching_ problems — acronym ↔ expansion (`IBM` ↔ `International Business Machines`),
 *   DBA/alias resolution beyond the simple clause, subsidiary/parent, and TF-IDF n-gram token
 *   matching — are deferred to a follow-up (a dedicated org-matching research pass + the matcher
 *   epic).
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
 * A domain pack name. Each protects the abbreviations that are meaningful in that domain from being
 * stripped as legal forms (see {@link DOMAIN_PROTECTED}). `general` protects nothing — the explicit
 * "no domain" choice. Add a pack here (and to {@link DOMAIN_PROTECTED}) per ingest domain.
 */
export type DesignationDomain = "general" | "healthcare"

/**
 * Context for {@link canonicalizeOrganizationName}. Omit both fields for the universal base
 * behavior.
 */
export interface CanonicalizeOptions {
	/**
	 * ISO 3166-1 alpha-2 country code of the org's jurisdiction (typically the resolved address
	 * country). Adds that country's legal forms — including collision-prone ones gated out of the
	 * base — to the strip-set. Case-insensitive; unknown codes add nothing.
	 */
	jurisdiction?: string
	/**
	 * Ingest domain. Protects domain-meaningful abbreviations (e.g. `healthcare` protects `pt` /
	 * `sca` / `scs`) from being stripped, overriding any jurisdiction pack that would add them.
	 */
	domain?: DesignationDomain
}

/**
 * Universal legal-entity designations — the forms that are safe to strip regardless of jurisdiction
 * or domain because they don't collide with common domain abbreviations. Normalized to lowercase
 * with punctuation removed (so `L.L.C.` → `llc`). Drawn from the ISO 20275 register + `cleanco`'s
 * common set. Stripped as whole tokens wherever they occur. Deliberately excludes name-meaningful
 * words (`group`, `holdings`, `partners`, `associates`) AND the collision-prone forms (`pt`, `sca`,
 * `scs`) — those last live in {@link JURISDICTION_DESIGNATIONS}, gated behind a known jurisdiction.
 */
const BASE_DESIGNATIONS = new Set([
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
	// Belgian forms — safe to add to the base (no domain collision).
	"bvba",
	"sprl",
])

/**
 * Jurisdiction-gated legal forms (ISO 3166-1 alpha-2 → forms), added only when the jurisdiction is
 * known. This is where the collision-prone tokens live: `pt` (Indonesia), `sca` / `scs`
 * (French/Belgian/Luxembourg commandite forms). Stripping these is correct ONLY when we know the
 * org's country — never in the universal base. Grounded seeds, not exhaustive; extend per ISO
 * 20275.
 */
const JURISDICTION_DESIGNATIONS: Record<string, readonly string[]> = {
	ID: ["pt", "tbk", "ud"], // Perseroan Terbatas / Terbuka (listed) / Usaha Dagang
	FR: ["sca", "scs", "sci", "eurl", "sasu", "snc"],
	BE: ["sca", "scs"],
	LU: ["sca", "scs"],
	ES: ["scs"], // Sociedad en Comandita Simple
	IT: ["sapa", "snc"], // S.a.p.a. (commandite par actions) / società in nome collettivo
}

/**
 * Domain protect-sets (domain → tokens never stripped). Overrides any jurisdiction pack: a token
 * here stays in the name even if the org's jurisdiction would treat it as a legal form.
 * `healthcare` guards the clinical abbreviations that collide with gated legal forms — `pt`
 * (Physical Therapy), `sca` (Sudden Cardiac Arrest), `scs` (Spinal Cord Stimulator) — plus a couple
 * of always-clinical ones for future-proofing.
 */
const DOMAIN_PROTECTED: Record<DesignationDomain, readonly string[]> = {
	general: [],
	healthcare: ["pt", "sca", "scs", "ot", "dpt"],
}

/**
 * Compute the effective designation strip-set for the given context: `(base ∪ jurisdiction-pack) −
 * domain-protect-pack`. Returns the shared base set unchanged when no context is given (the
 * byte-stable default), so the common path allocates nothing.
 */
function resolveDesignations(options?: CanonicalizeOptions): ReadonlySet<string> {
	const jurisdiction = options?.jurisdiction?.trim().toUpperCase()
	const jurisdictionPack = jurisdiction ? JURISDICTION_DESIGNATIONS[jurisdiction] : undefined
	const protectPack = options?.domain ? DOMAIN_PROTECTED[options.domain] : undefined

	if (!jurisdictionPack && !protectPack?.length) return BASE_DESIGNATIONS

	const set = new Set(BASE_DESIGNATIONS)
	if (jurisdictionPack) for (const token of jurisdictionPack) set.add(token)
	if (protectPack) for (const token of protectPack) set.delete(token)
	return set
}

/** Splits a `doing business as` / trade-name clause from a legal name. */
const DBA_PATTERN = /\s+(?:d\/b\/a|dba|doing business as|t\/a|trading as|a\/k\/a|aka|fka|f\/k\/a)\s+/i

/**
 * Canonicalize one name fragment: lowercase, strip accents, connectives → `and`, drop punctuation,
 * remove a leading `the`, strip legal designations, collapse whitespace. Returns the key plus the
 * designations it removed.
 */
function canonicalizeFragment(
	fragment: string,
	designationSet: ReadonlySet<string>
): { canonical: string; designations: string[] } {
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
		if (designationSet.has(token)) designations.push(token)
		else kept.push(token)
	}

	return { canonical: kept.join(" "), designations }
}

/**
 * Canonicalize an organization name: split off any `doing business as` clause, then reduce the
 * legal name to a designation-stripped key. Returns `null` for empty input.
 *
 * Pass {@link CanonicalizeOptions} to resolve the jurisdiction × domain collision (#668): a
 * `jurisdiction` adds that country's legal forms, a `domain` protects its meaningful abbreviations.
 * With no options the universal base set is used and the result is byte-for-byte the legacy
 * behavior.
 */
export function canonicalizeOrganizationName(
	input: string | null | undefined,
	options?: CanonicalizeOptions
): OrganizationName | null {
	if (typeof input !== "string" || !input.trim()) return null

	const raw = input
	const designationSet = resolveDesignations(options)
	const [legalPart, ...dbaParts] = input.split(DBA_PATTERN)

	const { canonical, designations } = canonicalizeFragment(legalPart ?? "", designationSet)

	const result: OrganizationName = { raw, canonical, designations }

	if (dbaParts.length) {
		const dba = canonicalizeFragment(dbaParts.join(" "), designationSet).canonical
		if (dba) result.dba = dba
	}

	return result
}

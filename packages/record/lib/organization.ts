/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canonicalizes organization names by removing legal designations. It normalizes DBA clauses plus punctuation and accents.
 *   It also folds connectives and leading articles. Jurisdiction adds local legal forms. Domain rules preserve
 *   ambiguous terms that could otherwise be stripped.
 */

import { foldForKey } from "@mailwoman/codex/address/key"

/**
 * A canonicalized organization name.
 */
export interface OrganizationName {
	/**
	 * The original input, verbatim.
	 */
	raw: string
	/**
	 * Normalized, designation-stripped key for blocking and comparison.
	 */
	canonical: string
	/**
	 * Legal designations that were stripped (`llc`, `inc`, `gmbh`), in encounter order.
	 */
	designations: string[]
	/**
	 * The `doing business as` / trade-name clause, canonicalized, when one was present.
	 */
	dba?: string
}

/**
 * Names a domain pack.
 *
 * Each pack leaves domain-specific abbreviations in the organization name
 * instead of stripping them as legal forms.
 * The `general` pack adds no domain-specific abbreviations.
 */
export type DesignationDomain = "general" | "healthcare"

/**
 * Context for {@link canonicalizeOrganizationName}; omit both fields for the universal base behavior.
 */
export interface CanonicalizeOptions {
	/**
	 * ISO 3166-1 alpha-2 country code for the organization's jurisdiction.
	 *
	 * Its country pack adds that jurisdiction's legal forms to the strip set.
	 * The comparison ignores case.
	 * Unknown codes add no pack.
	 */
	jurisdiction?: string
	/**
	 * Ingest domain that keeps domain-specific abbreviations in organization names.
	 *
	 * The `healthcare` domain leaves `pt` in the name.
	 * It also leaves `sca` and `scs`.
	 * These rules take precedence over jurisdiction packs.
	 */
	domain?: DesignationDomain
}

/**
 * Universal legal-entity designations, normalized to lowercase without punctuation
 * and stripped as whole tokens.
 *
 * Name-meaningful words and the collision-prone forms that live in
 * {@link JURISDICTION_DESIGNATIONS} are deliberately absent.
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
	// Belgian forms, safe in the base because they collide with no domain.
	"bvba",
	"sprl",
])

/**
 * Jurisdiction-conditional legal forms (ISO 3166-1 alpha-2 → forms) added only when the jurisdiction
 * is known, holding the collision-prone tokens (`pt`, `sca`, `scs`) that the base must not strip.
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
 * Domain guard-sets (domain → tokens never stripped) that override any jurisdiction pack,
 * e.g. `healthcare` keeps `pt`, `sca`, and `scs` from being stripped as legal forms.
 */
const DOMAIN_PROTECTED: Record<DesignationDomain, readonly string[]> = {
	general: [],
	healthcare: ["pt", "sca", "scs", "ot", "dpt"],
}

/**
 * Compute the effective strip-set `(base ∪ jurisdiction-pack) − domain-guard-pack`.
 *
 * @returns the shared base set unchanged when no context is given (the byte-stable default),
 * so the common path allocates no set.
 */
function resolveDesignations(options?: CanonicalizeOptions): ReadonlySet<string> {
	const jurisdiction = options?.jurisdiction?.trim().toUpperCase()
	const jurisdictionPack = jurisdiction ? JURISDICTION_DESIGNATIONS[jurisdiction] : undefined
	const protectPack = options?.domain ? DOMAIN_PROTECTED[options.domain] : undefined

	if (!jurisdictionPack && !protectPack?.length) return BASE_DESIGNATIONS

	const set = new Set(BASE_DESIGNATIONS)

	if (jurisdictionPack) {
		for (const token of jurisdictionPack) {
			set.add(token)
		}
	}

	if (protectPack) {
		for (const token of protectPack) {
			set.delete(token)
		}
	}

	return set
}

/**
 * Splits a `doing business as` / trade-name clause from a legal name.
 */
const DBA_PATTERN = /\s+(?:d\/b\/a|dba|doing business as|t\/a|trading as|a\/k\/a|aka|fka|f\/k\/a)\s+/i

/**
 * Canonicalize one name fragment: lowercase, strip accents, connectives → `and`,
 * drop punctuation, remove a leading `the`, strip legal designations, collapse whitespace.
 *
 * @returns the key plus the designations it removed.
 */
function canonicalizeFragment(
	fragment: string,
	designationSet: ReadonlySet<string>
): { canonical: string; designations: string[] } {
	const normalized = foldForKey(fragment, { ampersand: "and", dropPeriods: true }).replace(/^the\s+/, "")

	const designations: string[] = []
	const kept: string[] = []

	for (const token of normalized.split(" ")) {
		if (!token) continue

		if (designationSet.has(token)) {
			designations.push(token)
		} else {
			kept.push(token)
		}
	}

	return { canonical: kept.join(" "), designations }
}

/**
 * Canonicalize an organization name: split off any `doing business as` clause,
 * then reduce the legal name to a designation-stripped key.
 *
 * Returns `null` for empty input. {@link CanonicalizeOptions} resolves conflicts
 * between jurisdiction and domain rules.
 */
export function canonicalizeOrganizationName(
	input: string | null,
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

		if (dba) {
			result.dba = dba
		}
	}

	return result
}

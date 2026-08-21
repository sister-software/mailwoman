/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Org-name similarity primitives for the NPPES benchmark's org-name entity truth.
 */

/**
 * Corporate-form words and articles stripped before two organization names are compared. The gold-set rule is "same
 * address + same org name ⇒ same entity", so the domain words carry the distinguishing signal while a legal-form suffix
 * would inflate agreement between unrelated co-located companies.
 */
const ORG_STOP = new Set([
	"llc",
	"inc",
	"incorporated",
	"corp",
	"corporation",
	"co",
	"ltd",
	"pllc",
	"pc",
	"pa",
	"lp",
	"llp",
	"the",
	"of",
	"and",
])

/**
 * The comparable token set of an organization name.
 */
export const orgTokens = (s: string): Set<string> =>
	new Set(
		s
			.toLowerCase()
			.replaceAll(/[^a-z0-9 ]/g, " ")
			.split(/\s+/)
			.filter((t) => t && !ORG_STOP.has(t))
	)

/**
 * Jaccard floor at or above which two {@linkcode orgTokens} sets count as the same organization — the gold-set
 * threshold.
 */
export const ORG_TAU = 0.7

/**
 * An NPI's primary registry identity: the org-name token set plus the address key of its practice location. Every grain
 * of the org-name truth blocks on a location and gates on the tokens.
 */
export interface NPIPrimary {
	tokens: Set<string>
	addrKey: string
}

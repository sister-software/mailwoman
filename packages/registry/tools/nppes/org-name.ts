/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Org-name similarity primitives for the NPPES benchmark's org-name entity truth.
 */

export { orgTokens } from "#tools/shared"

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

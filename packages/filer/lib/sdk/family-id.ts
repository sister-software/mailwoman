/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Derives `filer_family.family_id` values.
 */

import { canonicalizeOrganizationName } from "@mailwoman/record"

/**
 * Derives a `filer_family.family_id` from the canonical form of a holding- or management-company name.
 *
 * Canonicalization makes `"Acme Holdings Inc"` and `"acme holdings, INC."` share one family.
 * The `identifierType` prefix keeps a holding company and a management company
 * with the same canonical name in separate families.
 *
 * @returns `null` when the name canonicalizes to an empty string, such as a bare legal designation.
 */
export function mintFamilyID(identifierType: string, name: string): string | null {
	const organization = canonicalizeOrganizationName(name)

	if (!organization || !organization.canonical) return null

	return `${identifierType}:${organization.canonical}`
}

/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared `family_id` derivation (task 3 fix round 3) — pulled out of `build-filer.ts`, mirroring
 *   `guards.ts`'s own extraction precedent (that module's docstring: "a writer importing another writer's
 *   whole module just to borrow a guard is a coupling that gets worse with every new filer.db writer").
 *   `mintFamilyID` used to be `build-filer.ts`-only, correct while only the WRITER needed it — but
 *   `filer-lookup.ts`'s `readFamilyDisplayNames` (task 3 fix round 2) now ALSO needs this exact
 *   canonicalization rule, to tell apart WHICH target node's edge actually names a given `family_id` when a
 *   member carries more than one holding-/management-company edge under the same provenance tuple. Two
 *   independent re-derivations of "how does a raw name become a family_id" is precisely the "two
 *   definitions that can drift" hazard this phase has already burned a review round on once
 *   (`assertISODate`'s extraction to `guards.ts`) — one implementation, shared by writer and reader alike.
 */

import { canonicalizeOrganizationName } from "@mailwoman/record"

/**
 * Derive a stable `filer_family.family_id` from a holding-/management-company name's CANONICAL form — never the raw
 * string — so `"Acme Holdings Inc"` and `"ACME HOLDINGS, INC."` (same underlying entity, different casing/
 * punctuation/legal suffix) collapse onto the SAME family, the identical reduction `cluster-filers.ts`'s inferred pass
 * already relies on (`canonicalizeOrganizationName`, `@mailwoman/record`). Namespaced by `identifierType`
 * (`holding_company_name` vs `management_company_name`) so a holding company and a DIFFERENT management company that
 * happen to canonicalize to the same string never collapse into one family (spec §3.1 finding 1 — ownership and
 * operational control are different assertions, and that separation should hold for family membership too, not just for
 * the edge kind).
 *
 * Returns `null` when the name canonicalizes to an EMPTY string (rare — e.g. a bare legal-designation token with
 * nothing else surviving) — the same defensive check `cluster-filers.ts`'s `buildInferredRecords` makes before using a
 * canonical name as a blocking key: an empty canonical string can never usefully identify a family, so the caller skips
 * emitting a family row for it (`build-filer.ts`'s `insertFamilyMembership`) or skips attributing a display name to it
 * (`filer-lookup.ts`'s `readFamilyDisplayNames`).
 */
export function mintFamilyID(identifierType: string, name: string): string | null {
	const organization = canonicalizeOrganizationName(name)

	if (!organization || !organization.canonical) return null

	return `${identifierType}:${organization.canonical}`
}

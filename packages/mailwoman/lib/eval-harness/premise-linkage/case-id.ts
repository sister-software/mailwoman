/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The salted case identifier (#1902) — the only thing a published premise-linkage result carries
 *   that is derived from the address.
 *
 *   A bare hash of the input would be reversible in practice: the address space a provider grants
 *   access to is enumerable, so anyone holding the register can hash every row and read the published
 *   identifiers straight back. The salt is what breaks that, and it has to be RUN-SPECIFIC rather than
 *   repository-wide — two reports under one salt can be joined row-for-row into a longer record of the
 *   same premises, which is the linkage the identifier exists to prevent.
 */

import { sha256Hex } from "@mailwoman/core/utils"

/**
 * Hex characters kept from the digest. Sixty-four bits of identifier: long enough that a run's rows do not collide,
 * short enough that nobody mistakes it for something to look up.
 */
const CASE_ID_LENGTH = 16

/**
 * The shortest salt this harness will run with. Below this a salt is enumerable, and an enumerable salt is no salt: the
 * holder of the register recovers every published case identifier by trying them all.
 */
const MINIMUM_SALT_LENGTH = 16

/**
 * Refuse a salt that cannot do its job, BEFORE any row is read.
 *
 * Checked once at the start of a run rather than per row, so an operator who forgot to export the secret is told so
 * immediately instead of after the licensed file has been opened.
 */
export function assertUsableSalt(salt: string): void {
	if (salt.length < MINIMUM_SALT_LENGTH) {
		throw new Error(
			`premise-linkage: the run salt is ${salt.length} characters; at least ${MINIMUM_SALT_LENGTH} are required. ` +
				"Supply a fresh per-run secret through $MAILWOMAN_PREMISE_LINKAGE_SALT — never a constant, and never one " +
				"reused between published runs."
		)
	}
}

/**
 * The published identifier for one input under one run's salt.
 *
 * The NUL separator is required: without it `salt + input` lets a different (salt, input) split produce the same
 * digest, so two runs whose salts happen to be prefixes of one another would share identifiers.
 */
export function caseIDFor(input: string, salt: string): string {
	return sha256Hex(`${salt}\0${input}`).slice(0, CASE_ID_LENGTH)
}

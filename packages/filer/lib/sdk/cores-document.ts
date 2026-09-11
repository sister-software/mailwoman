/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @file CORES registration document lookup.
 */

import { ResourceError } from "@mailwoman/core/errors"

import { isFRN, type FRN } from "#frn"
import { parseCORESRegistration, type CORESRegistration } from "#sdk/cores-registration"

const CORES_BASE_URL = "https://apps.fcc.gov"

/**
 * The slice of {@linkcode CORESClient} a caller needs to fetch one registration — one method, so a test can substitute a
 * trivial stub instead of building an axios harness. Mirrors `exhibit21.ts`'s `SECDocumentClient` precedent, and a real
 * `createCORESClient()` instance satisfies it structurally.
 */
export interface CORESDocumentClient {
	getDocument(input: string | URL): Promise<string>
}

/**
 * The detail-page URL for one FRN.
 */
export function coresDetailURL(frn: FRN): string {
	return `${CORES_BASE_URL}/cores/searchDetail.do?frn=${frn}`
}

/**
 * Fetch and parse one FRN's registration. `null` when CORES has no record to state — see
 * {@linkcode parseCORESRegistration} for when that happens and why it is not an error.
 */
export async function fetchCORESRegistration(client: CORESDocumentClient, frn: FRN): Promise<CORESRegistration | null> {
	if (!isFRN(frn)) {
		throw ResourceError.from(400, `fetchCORESRegistration: invalid FRN ${JSON.stringify(frn)}`, "cores", "request")
	}

	return parseCORESRegistration(frn, await client.getDocument(coresDetailURL(frn)))
}

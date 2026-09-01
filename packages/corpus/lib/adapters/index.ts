/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adapter registry bootstrap.
 *
 *   Importing this module registers every built-in adapter with `defaultAdapterRegistry`. The CLI
 *   (`commands/corpus/list.tsx`, `commands/corpus/run.tsx`) imports it once at startup.
 *
 *   Adapters under construction live in their own subdirectories (`./wof-admin-json/`, `./ban/`, ...)
 *   and are added to the `BUILTIN_ADAPTERS` list here as they come online. Tests that need a
 *   pristine registry should construct their own `InMemoryAdapterRegistry` instead of mutating the
 *   default.
 *
 *   The WOF adapters export their canonical ids — `wof-admin` and `wof-postalcode` — so existing
 *   `mailwoman corpus build` callsites do not need to change despite the Phase 1.5.1 SQLite →
 *   JSON-bundle pivot (`./wof-admin-json/` and `./wof-postalcode-json/` directories hold the
 *   implementations; the registered ids are unchanged).
 */

import { banAdapter } from "#adapters/ban/adapter"
import { fccBdcAdapter } from "#adapters/fcc-bdc/adapter"
import { geonamesPostalAdapter } from "#adapters/geonames-postal/adapter"
import { geonamesAdapter } from "#adapters/geonames/adapter"
import { gnafAdapter } from "#adapters/gnaf/adapter"
import { openaddressesAdapter } from "#adapters/openaddresses/adapter"
import { overtureAdapter } from "#adapters/overture/adapter"
import { stateHiSchoolsAdapter } from "#adapters/state-hi-schools/adapter"
import { stateIaContractorsAdapter } from "#adapters/state-ia-contractors/adapter"
import { stateNyNotariesAdapter } from "#adapters/state-ny-notaries/adapter"
import { stateTxNotariesAdapter } from "#adapters/state-tx-notaries/adapter"
import { tigerAdapter } from "#adapters/tiger/adapter"
import { usgovHrsaFqhcAdapter } from "#adapters/usgov-hrsa-fqhc/adapter"
import { usgovImlsPlsAdapter } from "#adapters/usgov-imls-pls/adapter"
import { USGovIRSBMFAdapter } from "#adapters/usgov-irs-bmf/adapter"
import { usgovNADAdapter } from "#adapters/usgov-nad/adapter"
import { usgovNPPESAdapter } from "#adapters/usgov-nppes/adapter"
import { defaultAdapterRegistry } from "#adapters/utils"
import { wofAdminAdapter } from "#adapters/wof-admin-json/adapter"
import { wofPostalcodeAdapter } from "#adapters/wof-postalcode-json/adapter"
import type { CorpusAdapter } from "#types"

/**
 * Built-in adapters. Order is significant: `corpus build` iterates this list to drive every adapter in turn.
 * Coarse-first (admin → postcode), then street-level (BAN FR, TIGER US, OpenAddresses global), then adversarial-source
 * (FCC BDC US, HRSA FQHC US).
 *
 * The `usgov-samhsa-treatment-locator` adapter is intentionally absent from this list — the SAMHSA Open Data Foundry
 * bulk CSV the adapter was written against is no longer publicly distributed (see issue #33, 2026-05-17 investigation).
 * The factory + named export remain available so the adapter can be hand-registered if an operator obtains a compatible
 * CSV (FOIA, partner channel, upstream restoration). Re-add it here once a stable public source returns.
 */
export const BUILTIN_ADAPTERS: readonly CorpusAdapter[] = [
	wofAdminAdapter,
	wofPostalcodeAdapter,
	geonamesAdapter,
	geonamesPostalAdapter,
	banAdapter,
	tigerAdapter,
	openaddressesAdapter,
	overtureAdapter,
	gnafAdapter,
	fccBdcAdapter,
	usgovHrsaFqhcAdapter,
	usgovNPPESAdapter,
	usgovNADAdapter,
	usgovImlsPlsAdapter,
	USGovIRSBMFAdapter,
	stateIaContractorsAdapter,
	stateTxNotariesAdapter,
	stateNyNotariesAdapter,
	stateHiSchoolsAdapter,
]

for (const adapter of BUILTIN_ADAPTERS) {
	if (!defaultAdapterRegistry.get(adapter.id)) {
		defaultAdapterRegistry.register(adapter)
	}
}

export { BAN_ADAPTER_ID, banAdapter } from "#adapters/ban/adapter"
export { FCC_BDC_ADAPTER_ID, FCC_BDC_DEFAULT_LICENSE, fccBdcAdapter } from "#adapters/fcc-bdc/adapter"

export {
	GEONAMES_POSTAL_ADAPTER_ID,
	GEONAMES_POSTAL_DEFAULT_LICENSE,
	geonamesPostalAdapter,
} from "#adapters/geonames-postal/adapter"

export { GEONAMES_ADAPTER_ID, GEONAMES_DEFAULT_LICENSE, geonamesAdapter } from "#adapters/geonames/adapter"

export {
	OPENADDRESSES_ADAPTER_ID,
	OPENADDRESSES_DEFAULT_LICENSE,
	openaddressesAdapter,
} from "#adapters/openaddresses/adapter"

export {
	STATE_HI_SCHOOLS_ADAPTER_ID,
	STATE_HI_SCHOOLS_DEFAULT_LICENSE,
	stateHiSchoolsAdapter,
} from "#adapters/state-hi-schools/adapter"

export {
	STATE_IA_CONTRACTORS_ADAPTER_ID,
	STATE_IA_CONTRACTORS_DEFAULT_LICENSE,
	stateIaContractorsAdapter,
} from "#adapters/state-ia-contractors/adapter"

export {
	STATE_NY_NOTARIES_ADAPTER_ID,
	STATE_NY_NOTARIES_DEFAULT_LICENSE,
	stateNyNotariesAdapter,
} from "#adapters/state-ny-notaries/adapter"

export {
	STATE_TX_NOTARIES_ADAPTER_ID,
	STATE_TX_NOTARIES_DEFAULT_LICENSE,
	stateTxNotariesAdapter,
} from "#adapters/state-tx-notaries/adapter"

export { TIGER_ADAPTER_ID, TIGER_DEFAULT_LICENSE, tigerAdapter } from "#adapters/tiger/adapter"

export {
	USGOV_HRSA_FQHC_ADAPTER_ID,
	USGOV_HRSA_FQHC_DEFAULT_LICENSE,
	usgovHrsaFqhcAdapter,
} from "#adapters/usgov-hrsa-fqhc/adapter"

export {
	USGOV_IMLS_PLS_ADAPTER_ID,
	USGOV_IMLS_PLS_DEFAULT_LICENSE,
	usgovImlsPlsAdapter,
} from "#adapters/usgov-imls-pls/adapter"

export {
	USGOV_IRS_BMF_ADAPTER_ID,
	USGOV_IRS_BMF_DEFAULT_LICENSE,
	USGovIRSBMFAdapter,
} from "#adapters/usgov-irs-bmf/adapter"

export { USGOV_NAD_ADAPTER_ID, USGOV_NAD_DEFAULT_LICENSE, usgovNADAdapter } from "#adapters/usgov-nad/adapter"
export { USGOV_NPPES_ADAPTER_ID, USGOV_NPPES_DEFAULT_LICENSE, usgovNPPESAdapter } from "#adapters/usgov-nppes/adapter"

export {
	USGOV_SAMHSA_ADAPTER_ID,
	USGOV_SAMHSA_DEFAULT_LICENSE,
	usgovSamhsaTreatmentLocatorAdapter,
} from "#adapters/usgov-samhsa-treatment-locator/adapter"

export { WOF_ADMIN_ADAPTER_ID, wofAdminAdapter } from "#adapters/wof-admin-json/adapter"
export { WOF_POSTALCODE_ADAPTER_ID, wofPostalcodeAdapter } from "#adapters/wof-postalcode-json/adapter"

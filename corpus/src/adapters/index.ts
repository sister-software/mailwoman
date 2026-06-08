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

import { defaultAdapterRegistry } from "../adapter.js"
import type { CorpusAdapter } from "../types.js"
import { banAdapter } from "./ban/adapter.js"
import { fccBdcAdapter } from "./fcc-bdc/adapter.js"
import { geonamesAdapter } from "./geonames/adapter.js"
import { geonamesPostalAdapter } from "./geonames-postal/adapter.js"
import { openaddressesAdapter } from "./openaddresses/adapter.js"
import { stateHiSchoolsAdapter } from "./state-hi-schools/adapter.js"
import { stateIaContractorsAdapter } from "./state-ia-contractors/adapter.js"
import { stateNyNotariesAdapter } from "./state-ny-notaries/adapter.js"
import { stateTxNotariesAdapter } from "./state-tx-notaries/adapter.js"
import { tigerAdapter } from "./tiger/adapter.js"
import { usgovHrsaFqhcAdapter } from "./usgov-hrsa-fqhc/adapter.js"
import { usgovImlsPlsAdapter } from "./usgov-imls-pls/adapter.js"
import { usgovIrsBmfAdapter } from "./usgov-irs-bmf/adapter.js"
import { usgovNadAdapter } from "./usgov-nad/adapter.js"
import { usgovNppesAdapter } from "./usgov-nppes/adapter.js"
import { wofAdminAdapter } from "./wof-admin-json/adapter.js"
import { wofPostalcodeAdapter } from "./wof-postalcode-json/adapter.js"

/**
 * Built-in adapters. Order is significant: `corpus build` iterates this list to drive every adapter
 * in turn. Coarse-first (admin → postcode), then street-level (BAN FR, TIGER US, OpenAddresses
 * global), then adversarial-source (FCC BDC US, HRSA FQHC US).
 *
 * The `usgov-samhsa-treatment-locator` adapter is intentionally absent from this list — the SAMHSA
 * Open Data Foundry bulk CSV the adapter was written against is no longer publicly distributed (see
 * issue #33, 2026-05-17 investigation). The factory + named export remain available so the adapter
 * can be hand-registered if an operator obtains a compatible CSV (FOIA, partner channel, upstream
 * restoration). Re-add it here once a stable public source returns.
 */
export const BUILTIN_ADAPTERS: readonly CorpusAdapter[] = [
	wofAdminAdapter,
	wofPostalcodeAdapter,
	geonamesAdapter,
	geonamesPostalAdapter,
	banAdapter,
	tigerAdapter,
	openaddressesAdapter,
	fccBdcAdapter,
	usgovHrsaFqhcAdapter,
	usgovNppesAdapter,
	usgovNadAdapter,
	usgovImlsPlsAdapter,
	usgovIrsBmfAdapter,
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

export { BAN_ADAPTER_ID, banAdapter } from "./ban/adapter.js"
export { FCC_BDC_ADAPTER_ID, FCC_BDC_DEFAULT_LICENSE, fccBdcAdapter } from "./fcc-bdc/adapter.js"
export { GEONAMES_ADAPTER_ID, GEONAMES_DEFAULT_LICENSE, geonamesAdapter } from "./geonames/adapter.js"
export {
	GEONAMES_POSTAL_ADAPTER_ID,
	GEONAMES_POSTAL_DEFAULT_LICENSE,
	geonamesPostalAdapter,
} from "./geonames-postal/adapter.js"
export {
	OPENADDRESSES_ADAPTER_ID,
	OPENADDRESSES_DEFAULT_LICENSE,
	openaddressesAdapter,
} from "./openaddresses/adapter.js"
export {
	STATE_HI_SCHOOLS_ADAPTER_ID,
	STATE_HI_SCHOOLS_DEFAULT_LICENSE,
	stateHiSchoolsAdapter,
} from "./state-hi-schools/adapter.js"
export {
	STATE_IA_CONTRACTORS_ADAPTER_ID,
	STATE_IA_CONTRACTORS_DEFAULT_LICENSE,
	stateIaContractorsAdapter,
} from "./state-ia-contractors/adapter.js"
export {
	STATE_NY_NOTARIES_ADAPTER_ID,
	STATE_NY_NOTARIES_DEFAULT_LICENSE,
	stateNyNotariesAdapter,
} from "./state-ny-notaries/adapter.js"
export {
	STATE_TX_NOTARIES_ADAPTER_ID,
	STATE_TX_NOTARIES_DEFAULT_LICENSE,
	stateTxNotariesAdapter,
} from "./state-tx-notaries/adapter.js"
export { TIGER_ADAPTER_ID, TIGER_DEFAULT_LICENSE, tigerAdapter } from "./tiger/adapter.js"
export {
	USGOV_HRSA_FQHC_ADAPTER_ID,
	USGOV_HRSA_FQHC_DEFAULT_LICENSE,
	usgovHrsaFqhcAdapter,
} from "./usgov-hrsa-fqhc/adapter.js"
export {
	USGOV_IMLS_PLS_ADAPTER_ID,
	USGOV_IMLS_PLS_DEFAULT_LICENSE,
	usgovImlsPlsAdapter,
} from "./usgov-imls-pls/adapter.js"
export {
	USGOV_IRS_BMF_ADAPTER_ID,
	USGOV_IRS_BMF_DEFAULT_LICENSE,
	usgovIrsBmfAdapter,
} from "./usgov-irs-bmf/adapter.js"
export { USGOV_NAD_ADAPTER_ID, USGOV_NAD_DEFAULT_LICENSE, usgovNadAdapter } from "./usgov-nad/adapter.js"
export { USGOV_NPPES_ADAPTER_ID, USGOV_NPPES_DEFAULT_LICENSE, usgovNppesAdapter } from "./usgov-nppes/adapter.js"
export {
	USGOV_SAMHSA_ADAPTER_ID,
	USGOV_SAMHSA_DEFAULT_LICENSE,
	usgovSamhsaTreatmentLocatorAdapter,
} from "./usgov-samhsa-treatment-locator/adapter.js"
export { WOF_ADMIN_ADAPTER_ID, wofAdminAdapter } from "./wof-admin-json/adapter.js"
export { WOF_POSTALCODE_ADAPTER_ID, wofPostalcodeAdapter } from "./wof-postalcode-json/adapter.js"

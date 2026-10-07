/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adapter registry bootstrap.
 *
 *   The module registers every built-in adapter with `defaultAdapterRegistry` when loaded. The CLI
 *   (`commands/corpus/list.tsx`, `commands/corpus/run.tsx`) imports it once at startup.
 *
 *   Each adapter has its own directory, and the publisher decides which parent it sits under. An
 *   adapter reading one country's publisher lives under that country, at `lib/<iso2>/adapters/<id>/`:
 *   G-NAF under `au`, Digitaal Vlaanderen under `be`, ČÚZK under `cz`, Klimadatastyrelsen under
 *   `dk`, Maa- ja Ruumiamet under `ee`, Ryhti under `fi`, BAN, FINESS and the Annuaire de l'éducation under `fr`, ANAC under `it`, the
 *   Administration du
 *   cadastre et de la topographie under `lu`, the State Address Register under `lv`, Kartverket's Matrikkelen
 *   under `no`, EMUiA under `pl`, Romania's school network under `ro`, and the FCC and USGov readers under `us`. A national publisher
 *   stays there even when its own files cover that state's dependencies, because the publisher is
 *   what the adapter reads: BAN covers France and ten overseas jurisdictions, Matrikkelen covers
 *   Norway and Svalbard, and Ryhti's one national file covers Åland beside the Finnish mainland.
 *
 *   Flanders is the counter-case worth stating. Its adapter sits under `be` and covers the Flemish
 *   Region only, because Brussels and Wallonia publish the INSPIRE theme through their own
 *   services, so Belgium needs three adapters rather than one.
 *
 *   Spain needs four, for the same reason. `es-catastro` reads the Dirección General del Catastro's
 *   52 provinces. `es-bizkaia`, `es-gipuzkoa` and `es-navarra` read the foral cadastres. Those
 *   cadastres state their own terms. The national feed links them rather than serving them.
 *
 *   An adapter reading a publisher that is not any one country's lives here, at `lib/adapters/<id>/`.
 *   That is the aggregators, `./openaddresses/`, `./osm/`, `./overture/`, `./geonames/` and `./wof/`,
 *   plus `./po-box/`.
 *
 *   A new adapter joins the `BUILTIN_ADAPTERS` list below. A test that needs a pristine registry
 *   constructs its own `InMemoryAdapterRegistry` rather than mutating the default.
 *
 *   The WOF adapters keep their canonical ids, `wof-admin` and `wof-postalcode`, so existing
 *   `mailwoman corpus build` callsites continue to work. `./wof/admin/json/` and
 *   `./wof/postalcode-json/` hold the implementations.
 */

import { cordisAdapter } from "#adapters/cordis/adapter"
import { geonamesAdapter } from "#adapters/geonames/adapter"
import { geonamesPostalAdapter } from "#adapters/geonames/postal/adapter"
import { gleifAdapter } from "#adapters/gleif/adapter"
import { openaddressesAdapter } from "#adapters/openaddresses/adapter"
import { osmAdapter } from "#adapters/osm/adapter"
import { overtureAdapter } from "#adapters/overture/adapter"
import { defaultAdapterRegistry } from "#adapters/registry"
import { wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
import { wofPostalcodeAdapter } from "#adapters/wof/postalcode-json/adapter"
import { gnafAdapter } from "#au/adapters/gnaf/adapter"
import { brusselsAdapter } from "#be/adapters/brussels/adapter"
import { vlaanderenAdapter } from "#be/adapters/vlaanderen/adapter"
import { wallonieAdapter } from "#be/adapters/wallonie/adapter"
import { czCuzkAdapter } from "#cz/adapters/cuzk/adapter"
import { dkInspireAdapter } from "#dk/adapters/inspire/adapter"
import { adsAdapter } from "#ee/adapters/ads/adapter"
import { esBizkaiaAdapter } from "#es/adapters/bizkaia/adapter"
import { esCatastroAdapter } from "#es/adapters/catastro/adapter"
import { esGipuzkoaAdapter } from "#es/adapters/gipuzkoa/adapter"
import { esNavarraAdapter } from "#es/adapters/navarra/adapter"
import { ryhtiAdapter } from "#fi/adapters/ryhti/adapter"
import { annuaireEducationAdapter } from "#fr/adapters/annuaire-education/adapter"
import { banAdapter } from "#fr/adapters/ban/adapter"
import { finessAdapter } from "#fr/adapters/finess/adapter"
import { itANACAdapter } from "#it/adapters/anac/adapter"
import { bdAdressesAdapter } from "#lu/adapters/bd-adresses/adapter"
import { varisAdapter } from "#lv/adapters/varis/adapter"
import { nlKadasterAdapter } from "#nl/adapters/kadaster/adapter"
import { matrikkelenAdapter } from "#no/adapters/matrikkelen/adapter"
import { emuiaAdapter } from "#pl/adapters/emuia/adapter"
import { reteaScolaraAdapter } from "#ro/adapters/retea-scolara/adapter"
import { skInspireAdapter } from "#sk/adapters/inspire/adapter"
import type { CorpusAdapter } from "#types"
import { fccBdcAdapter } from "#us/adapters/fcc-bdc/adapter"
import { stateHiSchoolsAdapter } from "#us/adapters/state/hi-schools/adapter"
import { stateIaContractorsAdapter } from "#us/adapters/state/ia-contractors/adapter"
import { stateNyNotariesAdapter } from "#us/adapters/state/ny-notaries/adapter"
import { stateTxNotariesAdapter } from "#us/adapters/state/tx-notaries/adapter"
import { tigerAdapter } from "#us/adapters/tiger/adapter"
import { usgovHrsaFqhcAdapter } from "#us/adapters/usgov/hrsa-fqhc/adapter"
import { usgovImlsPlsAdapter } from "#us/adapters/usgov/imls-pls/adapter"
import { USGovIRSBMFAdapter } from "#us/adapters/usgov/irs-bmf/adapter"
import { usgovNADAdapter } from "#us/adapters/usgov/nad/adapter"
import { usgovNPPESAdapter } from "#us/adapters/usgov/nppes/adapter"

/**
 * Built-in adapters.
 *
 * Order is significant, because `corpus build` iterates this list to drive every adapter in turn.
 * The order runs coarse-first (admin, then postcode), then street-level
 * (BAN FR, tiger US, OpenAddresses global), then adversarial-source (FCC BDC US, HRSA fqhc US).
 *
 * The `usgov-samhsa-treatment-locator` adapter is intentionally absent from this list.
 * The samhsa Open Data Foundry bulk CSV it was written against is no longer publicly distributed.
 *
 * Its factory and export remain available so an operator who obtains a compatible CSV can hand-register it.
 * Re-add it here once a stable public source returns.
 */
export const BUILTIN_ADAPTERS: readonly CorpusAdapter[] = [
	wofAdminAdapter,
	wofPostalcodeAdapter,
	geonamesAdapter,
	geonamesPostalAdapter,
	banAdapter,
	matrikkelenAdapter,
	ryhtiAdapter,
	czCuzkAdapter,
	dkInspireAdapter,
	adsAdapter,
	emuiaAdapter,
	vlaanderenAdapter,
	wallonieAdapter,
	brusselsAdapter,
	nlKadasterAdapter,
	bdAdressesAdapter,
	skInspireAdapter,
	esCatastroAdapter,
	esBizkaiaAdapter,
	esGipuzkoaAdapter,
	esNavarraAdapter,
	tigerAdapter,
	openaddressesAdapter,
	overtureAdapter,
	osmAdapter,
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
	itANACAdapter,
	reteaScolaraAdapter,
	cordisAdapter,
	varisAdapter,
	finessAdapter,
	annuaireEducationAdapter,
	gleifAdapter,
]

for (const adapter of BUILTIN_ADAPTERS) {
	if (!defaultAdapterRegistry.get(adapter.id)) {
		defaultAdapterRegistry.register(adapter)
	}
}

export { BAN_ADAPTER_ID, banAdapter } from "#fr/adapters/ban/adapter"
export { MATRIKKELEN_ADAPTER_ID, matrikkelenAdapter } from "#no/adapters/matrikkelen/adapter"
export { FCC_BDC_ADAPTER_ID, FCC_BDC_DEFAULT_LICENSE, fccBdcAdapter } from "#us/adapters/fcc-bdc/adapter"

export {
	GEONAMES_POSTAL_ADAPTER_ID,
	GEONAMES_POSTAL_DEFAULT_LICENSE,
	geonamesPostalAdapter,
} from "#adapters/geonames/postal/adapter"

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
} from "#us/adapters/state/hi-schools/adapter"

export {
	STATE_IA_CONTRACTORS_ADAPTER_ID,
	STATE_IA_CONTRACTORS_DEFAULT_LICENSE,
	stateIaContractorsAdapter,
} from "#us/adapters/state/ia-contractors/adapter"

export {
	STATE_NY_NOTARIES_ADAPTER_ID,
	STATE_NY_NOTARIES_DEFAULT_LICENSE,
	stateNyNotariesAdapter,
} from "#us/adapters/state/ny-notaries/adapter"

export {
	STATE_TX_NOTARIES_ADAPTER_ID,
	STATE_TX_NOTARIES_DEFAULT_LICENSE,
	stateTxNotariesAdapter,
} from "#us/adapters/state/tx-notaries/adapter"

export { TIGER_ADAPTER_ID, TIGER_DEFAULT_LICENSE, tigerAdapter } from "#us/adapters/tiger/adapter"

export {
	USGOV_HRSA_FQHC_ADAPTER_ID,
	USGOV_HRSA_FQHC_DEFAULT_LICENSE,
	usgovHrsaFqhcAdapter,
} from "#us/adapters/usgov/hrsa-fqhc/adapter"

export {
	USGOV_IMLS_PLS_ADAPTER_ID,
	USGOV_IMLS_PLS_DEFAULT_LICENSE,
	usgovImlsPlsAdapter,
} from "#us/adapters/usgov/imls-pls/adapter"

export {
	USGOV_IRS_BMF_ADAPTER_ID,
	USGOV_IRS_BMF_DEFAULT_LICENSE,
	USGovIRSBMFAdapter,
} from "#us/adapters/usgov/irs-bmf/adapter"

export { USGOV_NAD_ADAPTER_ID, USGOV_NAD_DEFAULT_LICENSE, usgovNADAdapter } from "#us/adapters/usgov/nad/adapter"

export {
	USGOV_NPPES_ADAPTER_ID,
	USGOV_NPPES_DEFAULT_LICENSE,
	usgovNPPESAdapter,
} from "#us/adapters/usgov/nppes/adapter"

export {
	USGOV_SAMHSA_ADAPTER_ID,
	USGOV_SAMHSA_DEFAULT_LICENSE,
	usgovSamhsaTreatmentLocatorAdapter,
} from "#us/adapters/usgov/samhsa-treatment-locator/adapter"

export { WOF_ADMIN_ADAPTER_ID, wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
export { WOF_POSTALCODE_ADAPTER_ID, wofPostalcodeAdapter } from "#adapters/wof/postalcode-json/adapter"

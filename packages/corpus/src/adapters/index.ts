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
import { openaddressesAdapter } from "./openaddresses/adapter.js"
import { tigerAdapter } from "./tiger/adapter.js"
import { wofAdminAdapter } from "./wof-admin-json/adapter.js"
import { wofPostalcodeAdapter } from "./wof-postalcode-json/adapter.js"

/**
 * Built-in adapters. Order is significant: `corpus build` iterates this list to drive every adapter
 * in turn. Coarse-first (admin → postcode), then street-level (BAN FR, TIGER US, OpenAddresses
 * global).
 */
export const BUILTIN_ADAPTERS: readonly CorpusAdapter[] = [
	wofAdminAdapter,
	wofPostalcodeAdapter,
	banAdapter,
	tigerAdapter,
	openaddressesAdapter,
]

for (const adapter of BUILTIN_ADAPTERS) {
	if (!defaultAdapterRegistry.get(adapter.id)) {
		defaultAdapterRegistry.register(adapter)
	}
}

export { BAN_ADAPTER_ID, banAdapter } from "./ban/adapter.js"
export {
	OPENADDRESSES_ADAPTER_ID,
	OPENADDRESSES_DEFAULT_LICENSE,
	openaddressesAdapter,
} from "./openaddresses/adapter.js"
export { TIGER_ADAPTER_ID, TIGER_DEFAULT_LICENSE, tigerAdapter } from "./tiger/adapter.js"
export { WOF_ADMIN_ADAPTER_ID, wofAdminAdapter } from "./wof-admin-json/adapter.js"
export { WOF_POSTALCODE_ADAPTER_ID, wofPostalcodeAdapter } from "./wof-postalcode-json/adapter.js"

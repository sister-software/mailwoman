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
 *   Adapters under construction live in their own subdirectories (`./wof-admin/`, `./ban/`, ...) and
 *   are added to the `BUILTIN_ADAPTERS` list here as they come online. Tests that need a pristine
 *   registry should construct their own `InMemoryAdapterRegistry` instead of mutating the default.
 */

import { defaultAdapterRegistry } from "../adapter.js"
import type { CorpusAdapter } from "../types.js"
import { banAdapter } from "./ban/adapter.js"
import { openaddressesAdapter } from "./openaddresses/adapter.js"
import { wofAdminAdapter } from "./wof-admin/adapter.js"
import { wofPostalcodeAdapter } from "./wof-postalcode/adapter.js"

/**
 * Built-in adapters. Order is significant: `corpus build` iterates this list to drive every adapter
 * in turn. Coarse-first (admin → postcode), then street-level (BAN FR, OpenAddresses global).
 */
export const BUILTIN_ADAPTERS: readonly CorpusAdapter[] = [
	wofAdminAdapter,
	wofPostalcodeAdapter,
	banAdapter,
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
export { WOF_ADMIN_ADAPTER_ID, wofAdminAdapter } from "./wof-admin/adapter.js"
export { WOF_POSTALCODE_ADAPTER_ID, wofPostalcodeAdapter } from "./wof-postalcode/adapter.js"

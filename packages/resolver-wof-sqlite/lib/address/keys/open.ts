/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressPointLookup } from "@mailwoman/core/resolver"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { dirname, resolvePath, type PathBuilderLike } from "path-ts"

import { localAddressStatementRunner } from "#address/keys/local-runner"
import { AddressKeyPointLookup } from "#address/keys/point-lookup"

/**
 * Opens one region's local `lookup.db`, and the `detail.db` beside it, as the
 * resolver's address-point tier, closing both files on dispose.
 *
 * @param country The ISO 3166-1 alpha-2 code of the country the file covers.
 */
export function openAddressLayerLookup(lookupPath: PathBuilderLike, country: string): AddressPointLookup & Disposable {
	const db = new DatabaseClient<unknown>(lookupPath, { readOnly: true })
	const detail = new DatabaseClient<unknown>(resolvePath(dirname(lookupPath), "detail.db"), { readOnly: true })

	const lookup = new AddressKeyPointLookup(localAddressStatementRunner(db), {
		country,
		detail: localAddressStatementRunner(detail),
	})

	return {
		find: (query) => lookup.find(query),
		[Symbol.dispose]: () => {
			db[Symbol.dispose]()
			detail[Symbol.dispose]()
		},
	}
}

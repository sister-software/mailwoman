/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A ledger whose writes fail, for a test of what a caller records when D1 refuses the row after the provider has
 *   already answered. Reads pass through untouched.
 */

import type { Ledger } from "@mailwoman/license-worker/ledger/client"

const WRITERS = new Set(["insertInto", "updateTable", "deleteFrom"])

export function ledgerRefusingWrites(ledger: Ledger, reason = "D1 refused the write"): Ledger {
	return new Proxy(ledger, {
		get(target, property, receiver) {
			if (typeof property === "string" && WRITERS.has(property)) {
				return () => {
					throw new Error(reason)
				}
			}

			const value = Reflect.get(target, property, receiver)

			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

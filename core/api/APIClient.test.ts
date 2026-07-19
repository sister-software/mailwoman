/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { buildStorage } from "axios-cache-interceptor"
import { expect, test } from "vitest"

import { APIClient } from "./APIClient.ts"

test("APIClient disposal reaches a caching storage whose asyncDispose lives on the prototype", async () => {
	let disposeCount = 0

	// The regression case: [Symbol.asyncDispose] on the PROTOTYPE chain, not an own property.
	// The pre-migration predicate (Object.hasOwn on the instance) never matched this shape,
	// leaving cache disposal as dead code.
	const storagePrototype = {
		async [Symbol.asyncDispose](): Promise<void> {
			disposeCount += 1
		},
	}

	const storage = Object.assign(
		Object.create(storagePrototype) as typeof storagePrototype,
		buildStorage({
			find: () => undefined,
			set: () => undefined,
			remove: () => undefined,
		})
	)

	const client = new APIClient({
		displayName: "dispose-probe",
		caching: { storage },
	})

	await client[Symbol.asyncDispose]()

	expect(disposeCount).toBe(1)
})

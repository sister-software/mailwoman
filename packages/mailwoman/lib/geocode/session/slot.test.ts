/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { sleep } from "@mailwoman/core/utils/sleep"
import { describe, expect, it } from "vitest"

import type { GeocodeSession } from "#geocode/session"
import { GeocodeSessionSlot } from "#geocode/session/slot"

/**
 * A session that records whether it was disposed, asserted to the interface
 * because the slot reads only disposal.
 */
function stubSession(name: string): GeocodeSession & { name: string; disposed: boolean } {
	const session = {
		name,
		disposed: false,
		[Symbol.asyncDispose]: async () => {
			session.disposed = true
		},
	}

	return session as unknown as GeocodeSession & { name: string; disposed: boolean }
}

describe("GeocodeSessionSlot", () => {
	it("keeps the previous session open until a request that started on it settles", async () => {
		const first = stubSession("first")
		const second = stubSession("second")
		const slot = new GeocodeSessionSlot(first)
		const { promise: held, resolve: release } = Promise.withResolvers<void>()

		const inFlight = slot.run(async (session) => {
			await held

			return (session as typeof first).name
		})

		const replaced = slot.replace(async () => second)

		await sleep(0)

		expect(slot.session).toBe(second)
		expect(first.disposed).toBe(false)

		release()

		await expect(inFlight).resolves.toBe("first")
		await replaced

		expect(first.disposed).toBe(true)
		expect(second.disposed).toBe(false)
	})

	it("keeps serving the current session when a replacement fails to build", async () => {
		const first = stubSession("first")
		const slot = new GeocodeSessionSlot(first)

		await expect(
			slot.replace(async () => {
				throw new Error("the new generation has no gazetteer")
			})
		).rejects.toThrow("the new generation has no gazetteer")

		expect(slot.session).toBe(first)
		expect(first.disposed).toBe(false)

		const second = stubSession("second")

		await slot.replace(async () => second)

		expect(slot.session).toBe(second)
		expect(first.disposed).toBe(true)
	})
})

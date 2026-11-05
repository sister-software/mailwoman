/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ConnectivityReading } from "@mailwoman/core/network/connectivity"
import { describe, expect, test, vi } from "vitest"

import { type GeocodeAttempt, type GeocoderProvider, ProviderPlacement } from "#provider"
import { GeocoderService, isUnavailableError } from "#service"

const ONLINE: ConnectivityReading = { online: true, reachable: true }
const OFFLINE: ConnectivityReading = { online: false, reachable: null }
const NO_SERVICE: ConnectivityReading = { online: true, reachable: false }

class StatusError extends Error {
	readonly status: number

	constructor(status: number) {
		super(`answered ${status}`)
		this.status = status
	}
}

type Behavior = (query: string, attempt: GeocodeAttempt) => Promise<string>

function provider(
	id: string,
	placement: ProviderPlacement,
	behavior: Behavior,
	ready = true
): GeocoderProvider<string, string> & { geocode: ReturnType<typeof vi.fn<Behavior>> } {
	return { id, placement, isReady: () => ready, geocode: vi.fn(behavior) }
}

const answers =
	(label: string): Behavior =>
	async (query) =>
		`${label}:${query}`

const failsWith =
	(error: unknown): Behavior =>
	async () => {
		throw error
	}

/**
 * A remote engine that answers only when its signal aborts, by rejecting with the abort reason.
 */
const hangs: Behavior = (_query, { signal }) =>
	new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason))
	})

describe("GeocoderService", () => {
	test("sends the query to the remote provider when the reading allows a request", async () => {
		const remote = provider("api.example.test", ProviderPlacement.Remote, answers("remote"))
		const local = provider("browser", ProviderPlacement.Local, answers("local"))
		const service = new GeocoderService({ remote, local, connectivity: () => ONLINE })

		const outcome = await service.geocode("Springfield, IL")

		expect(outcome).toEqual({
			answer: "remote:Springfield, IL",
			providerID: "api.example.test",
			placement: "remote",
			remoteError: null,
		})

		expect(local.geocode).not.toHaveBeenCalled()
	})

	test("sends the query straight to a ready local provider when the device is offline", async () => {
		const remote = provider("api.example.test", ProviderPlacement.Remote, answers("remote"))
		const local = provider("browser", ProviderPlacement.Local, answers("local"))
		const service = new GeocoderService({ remote, local, connectivity: () => OFFLINE })

		const outcome = await service.geocode("Springfield, IL")

		expect(outcome.answer).toBe("local:Springfield, IL")
		expect(remote.geocode).not.toHaveBeenCalled()
	})

	test("asks the local provider when the remote one is unavailable, and reports the remote error", async () => {
		const failure = new TypeError("Failed to fetch")
		const remote = provider("api.example.test", ProviderPlacement.Remote, failsWith(failure))
		const local = provider("browser", ProviderPlacement.Local, answers("local"))
		const onRemoteUnavailable = vi.fn()
		const service = new GeocoderService({ remote, local, connectivity: () => ONLINE, onRemoteUnavailable })

		const outcome = await service.geocode("10 Downing Street, London SW1A 2AA")

		expect(outcome.answer).toBe("local:10 Downing Street, London SW1A 2AA")
		expect(outcome.remoteError).toBe(failure)
		expect(onRemoteUnavailable).toHaveBeenCalledWith(failure)
	})

	test("asks the local provider when the remote deadline passes", async () => {
		const remote = provider("api.example.test", ProviderPlacement.Remote, hangs)
		const local = provider("browser", ProviderPlacement.Local, answers("local"))
		const service = new GeocoderService({ remote, local, connectivity: () => ONLINE, remoteDeadlineMs: 10 })

		const outcome = await service.geocode("Springfield, IL")

		expect(outcome.placement).toBe("local")
		expect((outcome.remoteError as Error).name).toBe("TimeoutError")
	})

	test("applies no deadline when no local provider is ready, so a slow remote answer still arrives", async () => {
		const remote = provider("api.example.test", ProviderPlacement.Remote, async (query, { signal }) => {
			await new Promise((resolve) => {
				setTimeout(resolve, 30)
			})

			signal.throwIfAborted()

			return `remote:${query}`
		})

		const local = provider("browser", ProviderPlacement.Local, answers("local"), false)
		const service = new GeocoderService({ remote, local, connectivity: () => ONLINE, remoteDeadlineMs: 5 })

		await expect(service.geocode("Springfield, IL")).resolves.toMatchObject({ answer: "remote:Springfield, IL" })
	})

	test("passes a refusal through without asking the local provider", async () => {
		const refusal = new StatusError(403)
		const remote = provider("api.example.test", ProviderPlacement.Remote, failsWith(refusal))
		const local = provider("browser", ProviderPlacement.Local, answers("local"))
		const onRemoteUnavailable = vi.fn()
		const service = new GeocoderService({ remote, local, connectivity: () => ONLINE, onRemoteUnavailable })

		await expect(service.geocode("Springfield, IL")).rejects.toBe(refusal)
		expect(local.geocode).not.toHaveBeenCalled()
		expect(onRemoteUnavailable).not.toHaveBeenCalled()
	})

	test("passes the caller's cancellation through without asking the local provider", async () => {
		const remote = provider("api.example.test", ProviderPlacement.Remote, hangs)
		const local = provider("browser", ProviderPlacement.Local, answers("local"))
		const service = new GeocoderService({ remote, local, connectivity: () => ONLINE })
		const controller = new AbortController()

		const pending = service.geocode("Springfield, IL", { signal: controller.signal })
		controller.abort()

		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
		expect(local.geocode).not.toHaveBeenCalled()
	})

	test("rethrows the remote error when no local provider is ready", async () => {
		const failure = new StatusError(503)
		const remote = provider("api.example.test", ProviderPlacement.Remote, failsWith(failure))
		const service = new GeocoderService({ remote, connectivity: () => ONLINE })

		await expect(service.geocode("Springfield, IL")).rejects.toBe(failure)
	})

	test("rejects with a connectivity error when the reading rules out the request and no local provider is ready", async () => {
		const remote = provider("api.example.test", ProviderPlacement.Remote, answers("remote"))
		const service = new GeocoderService({ remote, connectivity: () => NO_SERVICE })

		await expect(service.geocode("Springfield, IL")).rejects.toMatchObject({
			status: 503,
			name: "connectivity:network:service-unreachable",
		})

		expect(remote.geocode).not.toHaveBeenCalled()
	})

	test("tries the remote provider while the reading is unknown", async () => {
		const remote = provider("api.example.test", ProviderPlacement.Remote, answers("remote"))
		const service = new GeocoderService({ remote, connectivity: () => ({ online: null, reachable: null }) })

		await expect(service.geocode("Springfield")).resolves.toMatchObject({ answer: "remote:Springfield" })
	})
})

describe("isUnavailableError", () => {
	test("separates an unreachable or failing service from a refusal", () => {
		expect(isUnavailableError(new TypeError("Failed to fetch"))).toBe(true)
		expect(isUnavailableError(new DOMException("deadline", "TimeoutError"))).toBe(true)
		expect(isUnavailableError(new StatusError(500))).toBe(true)
		expect(isUnavailableError(new StatusError(429))).toBe(true)
		expect(isUnavailableError(new StatusError(400))).toBe(false)
		expect(isUnavailableError(new StatusError(404))).toBe(false)
		expect(isUnavailableError(new Error("unreadable body"))).toBe(false)
	})
})

// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { ConnectivityReading } from "@mailwoman/core/network/connectivity"
import type { ParseResult } from "@mailwoman/core/pipeline/client-result"
import { type GeocoderProvider, GeocoderService, ProviderPlacement } from "@mailwoman/geocoder-service"
import type { GeocoderRuntime, MapBias } from "@mailwoman/react/map"
import { makeFakeGeocoderRuntime } from "@mailwoman/react/map/fake-runtime"
import { describe, expect, test, vi } from "vitest"

import { DeviceTier, THREE_D_BUDGETS } from "#memory/device-tier"
import type { MemoryProfile } from "#memory/profile"
import {
	BROWSER_PROVIDER_ID,
	BrowserRuntimeSlot,
	createLocalFallbackProvider,
	localFallbackPermitted,
	type LocalFallbackQuery,
} from "#runtime/local-fallback"

const ONLINE: ConnectivityReading = { online: true, reachable: true }
const OFFLINE: ConnectivityReading = { online: false, reachable: null }

interface Answer {
	result: ParseResult
	engine: string | null
}

type BiasedParse = NonNullable<GeocoderRuntime["runParseWithBias"]>

/**
 * A canned browser runtime, with a spy on the parse the provider calls.
 */
function browserRuntime(ready: boolean): { runtime: GeocoderRuntime; parse: ReturnType<typeof vi.fn<BiasedParse>> } {
	const canned = makeFakeGeocoderRuntime()
	const parse = vi.fn<BiasedParse>((input, _viewport, hooks) => canned.runParse(input, hooks))

	return { runtime: { ...canned, ready, runParseWithBias: parse }, parse }
}

function hostedProvider(behavior: () => Promise<Answer>): GeocoderProvider<LocalFallbackQuery, Answer> {
	return { id: "api.example", placement: ProviderPlacement.Remote, isReady: () => true, geocode: behavior }
}

const unavailable = Object.assign(new Error("answered 503"), { status: 503 })

const failsUnavailable = async (): Promise<Answer> => {
	throw unavailable
}

const toAnswer = (result: ParseResult): Answer => ({ result, engine: null })

describe("createLocalFallbackProvider", () => {
	test("is unready before the page mounts a browser runtime and while its release loads", () => {
		const slot = new BrowserRuntimeSlot()
		const provider = createLocalFallbackProvider(slot.read, toAnswer)

		expect(provider.isReady()).toBe(false)

		slot.set(browserRuntime(false).runtime)
		expect(provider.isReady()).toBe(false)

		slot.set(browserRuntime(true).runtime)
		expect(provider.isReady()).toBe(true)

		slot.set(null)
		expect(provider.isReady()).toBe(false)
	})

	test("answers in the browser, with the viewport, when the hosted API answers 503", async () => {
		const { runtime, parse } = browserRuntime(true)
		const viewport: MapBias = { center: [-9.14, 38.72], zoom: 9 }

		const service = new GeocoderService<LocalFallbackQuery, Answer>({
			remote: hostedProvider(failsUnavailable),
			local: createLocalFallbackProvider(() => runtime, toAnswer),
			connectivity: () => ONLINE,
		})

		const outcome = await service.geocode({ input: "Rua Augusta, Lisboa", viewport })

		expect(outcome).toMatchObject({
			providerID: BROWSER_PROVIDER_ID,
			placement: ProviderPlacement.Local,
			remoteError: unavailable,
		})

		expect(parse).toHaveBeenCalledWith("Rua Augusta, Lisboa", viewport, expect.anything())
		expect(outcome.answer).toEqual({ result: await parse.mock.results[0]?.value, engine: null })
	})

	test("rejects with the hosted failure while the browser runtime is still loading", async () => {
		const onRemoteUnavailable = vi.fn()

		const service = new GeocoderService<LocalFallbackQuery, Answer>({
			remote: hostedProvider(failsUnavailable),
			local: createLocalFallbackProvider(() => browserRuntime(false).runtime, toAnswer),
			connectivity: () => ONLINE,
			onRemoteUnavailable,
		})

		await expect(service.geocode({ input: "Lisboa", viewport: null })).rejects.toBe(unavailable)

		// The page starts the model download from this call.
		expect(onRemoteUnavailable).toHaveBeenCalledOnce()
	})

	test("answers in the browser without a request while the device is offline", async () => {
		const hosted = vi.fn(failsUnavailable)

		const service = new GeocoderService<LocalFallbackQuery, Answer>({
			remote: hostedProvider(hosted),
			local: createLocalFallbackProvider(() => browserRuntime(true).runtime, toAnswer),
			connectivity: () => OFFLINE,
		})

		const outcome = await service.geocode({ input: "Lisboa", viewport: null })

		expect(outcome.placement).toBe(ProviderPlacement.Local)
		expect(hosted).not.toHaveBeenCalled()
	})
})

describe("localFallbackPermitted", () => {
	const profile = (tripped: boolean): MemoryProfile => ({
		detectedTier: DeviceTier.Desktop,
		tier: DeviceTier.Desktop,
		crashGuard: { tripped, phases: [] },
		threeD: !tripped,
		budget: THREE_D_BUDGETS[DeviceTier.Desktop],
	})

	test("waits for the crash guard's reading, and refuses after an earlier load ended in a heavy phase", () => {
		expect(localFallbackPermitted(null)).toBe(false)
		expect(localFallbackPermitted(profile(false))).toBe(true)
		expect(localFallbackPermitted(profile(true))).toBe(false)
	})
})

// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import {
	type ConnectivityContextValue,
	ReachabilityProvider,
	useConnectivity,
} from "@mailwoman/react/network/ReachabilityProvider"
import { act } from "react"
import { afterEach, expect, test, vi } from "vitest"

import { cleanup, renderComponent } from "../../test/render.tsx"

const HEALTH = "https://api.example.test/health"

afterEach(async () => {
	await cleanup()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function Consumer({ onRender }: { onRender: (value: ConnectivityContextValue) => void }) {
	onRender(useConnectivity())

	return null
}

/**
 * Renders a provider whose consumer reports the context value on each render, and returns the latest one.
 */
function renderProvider(url: string | null) {
	const seen: { current: ConnectivityContextValue | null } = { current: null }

	const record = (value: ConnectivityContextValue) => {
		seen.current = value
	}

	renderComponent(
		<ReachabilityProvider url={url}>
			<Consumer onRender={record} />
		</ReachabilityProvider>
	)

	return seen
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => {
			setTimeout(resolve, 0)
		})
	})
}

test("probes the route on mount and reports the result", async () => {
	const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
	vi.stubGlobal("fetch", fetchStub)

	const seen = renderProvider(HEALTH)

	await settle()

	expect(fetchStub).toHaveBeenCalledTimes(1)
	expect(seen.current?.reading).toEqual({ online: true, reachable: true })
	expect(seen.current?.read()).toEqual({ online: true, reachable: true })
})

test("reports a failing route as unreachable, and recheck probes again", async () => {
	const fetchStub = vi.fn(async () => new Response(null, { status: 503 }))
	vi.stubGlobal("fetch", fetchStub)

	const seen = renderProvider(HEALTH)

	await settle()

	expect(seen.current?.reading.reachable).toBe(false)

	fetchStub.mockImplementation(async () => new Response(null, { status: 200 }))

	act(() => seen.current?.recheck())
	await settle()

	expect(fetchStub).toHaveBeenCalledTimes(2)
	expect(seen.current?.reading.reachable).toBe(true)
})

test("an offline event reports both signals false without probing", async () => {
	const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
	vi.stubGlobal("fetch", fetchStub)

	const seen = renderProvider(HEALTH)

	await settle()

	vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)

	act(() => {
		self.dispatchEvent(new Event("offline"))
	})

	await settle()

	expect(fetchStub).toHaveBeenCalledTimes(1)
	expect(seen.current?.read()).toEqual({ online: false, reachable: false })
})

test("without a route, reports only navigator.onLine", async () => {
	const fetchStub = vi.fn(async () => new Response(null, { status: 200 }))
	vi.stubGlobal("fetch", fetchStub)

	const seen = renderProvider(null)

	await settle()

	expect(fetchStub).not.toHaveBeenCalled()
	expect(seen.current?.reading).toEqual({ online: true, reachable: null })
})

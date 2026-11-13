// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { afterEach, describe, expect, test, vi } from "vitest"

import {
	type RegisterServiceWorker,
	registerServiceWorkerUpdates,
	serviceWorkerControl,
} from "#site-kit/service-worker-client"

/**
 * The browser globals the client reads, on an `EventTarget` standing in for the window.
 */
function stubBrowser(options: { controlled: boolean; onLine: boolean }) {
	const page = new EventTarget()
	const serviceWorker = Object.assign(new EventTarget(), { controller: options.controlled ? {} : null })
	const reload = vi.fn()
	const stored = new Map<string, string>()

	vi.stubGlobal("navigator", { serviceWorker, onLine: options.onLine })
	vi.stubGlobal("location", { reload })
	vi.stubGlobal("addEventListener", page.addEventListener.bind(page))

	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
	})

	return { page, serviceWorker, reload }
}

/**
 * A `registerSW` stand-in that records its options and the reload flag it was called with.
 */
function fakeRegister() {
	const calls: { options: Parameters<RegisterServiceWorker>[0]; updates: (boolean | undefined)[] } = {
		options: {},
		updates: [],
	}

	const register: RegisterServiceWorker = (options) => {
		calls.options = options

		return async (reloadPage) => {
			calls.updates.push(reloadPage)
		}
	}

	return { register, calls }
}

function preloadError(): Event {
	return new Event("vite:preloadError", { cancelable: true })
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("registerServiceWorkerUpdates", () => {
	test("shows the update notice when a worker waits, and applying it asks the worker without a second reload", () => {
		const browser = stubBrowser({ controlled: true, onLine: true })
		const { register, calls } = fakeRegister()
		const updates = registerServiceWorkerUpdates(register)
		const listener = vi.fn()

		updates.subscribe(listener)
		expect(updates.getSnapshot()).toBe("none")

		calls.options.onNeedRefresh?.()

		expect(updates.getSnapshot()).toBe("update-ready")
		expect(listener).toHaveBeenCalledTimes(1)

		updates.applyUpdate()
		expect(calls.updates).toEqual([false])

		// The new worker takes control, and this page reloads once.
		browser.serviceWorker.dispatchEvent(new Event("controllerchange"))
		browser.serviceWorker.dispatchEvent(new Event("controllerchange"))
		expect(browser.reload).toHaveBeenCalledTimes(1)
	})

	test("reloads once on a stale module while online, and leaves a repeat failure to Vite", () => {
		const browser = stubBrowser({ controlled: true, onLine: true })

		registerServiceWorkerUpdates(fakeRegister().register)

		const first = preloadError()
		const second = preloadError()

		browser.page.dispatchEvent(first)
		browser.page.dispatchEvent(second)

		expect(browser.reload).toHaveBeenCalledTimes(1)
		expect(first.defaultPrevented).toBe(true)
		expect(second.defaultPrevented).toBe(false)
	})

	test("waits for a connection before reloading on a stale module while offline", () => {
		const browser = stubBrowser({ controlled: true, onLine: false })
		const updates = registerServiceWorkerUpdates(fakeRegister().register)

		browser.page.dispatchEvent(preloadError())

		expect(browser.reload).not.toHaveBeenCalled()
		expect(updates.getSnapshot()).toBe("update-needs-connection")

		browser.page.dispatchEvent(new Event("online"))
		expect(browser.reload).toHaveBeenCalledTimes(1)
	})

	test("doesn't reload a first visit when its first worker takes control", () => {
		const browser = stubBrowser({ controlled: false, onLine: true })

		registerServiceWorkerUpdates(fakeRegister().register)
		browser.serviceWorker.dispatchEvent(new Event("controllerchange"))

		expect(browser.reload).not.toHaveBeenCalled()
	})
})

describe("serviceWorkerControl", () => {
	test("resolves when the first visit's worker claims the page", async () => {
		const browser = stubBrowser({ controlled: false, onLine: true })
		const control = serviceWorkerControl(10_000)

		browser.serviceWorker.dispatchEvent(new Event("controllerchange"))

		await expect(control).resolves.toBe("controlled")
	})

	test("resolves at once on a page a worker already controls", async () => {
		stubBrowser({ controlled: true, onLine: true })

		await expect(serviceWorkerControl(10_000)).resolves.toBe("controlled")
	})

	test("stops waiting after the timeout when no worker takes control", async () => {
		vi.useFakeTimers()

		try {
			stubBrowser({ controlled: false, onLine: true })

			const control = serviceWorkerControl(5000)

			vi.advanceTimersByTime(5000)

			await expect(control).resolves.toBe("timed-out")
		} finally {
			vi.useRealTimers()
		}
	})

	test("resolves at once in a browser without service workers", async () => {
		vi.stubGlobal("navigator", {})

		await expect(serviceWorkerControl(10_000)).resolves.toBe("unsupported")
	})
})

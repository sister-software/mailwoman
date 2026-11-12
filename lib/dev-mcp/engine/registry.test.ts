// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { GeocodeSession } from "mailwoman/geocode"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { EngineRegistry } from "#dev-mcp/engine/registry"
import type { TreeFingerprint } from "#dev-mcp/tree-fingerprint"

const FINGERPRINT: TreeFingerprint = {
	digest: "tree0",
	gitHead: "head0",
	dirtyFiles: [],
	newestMtimeMs: 0,
	newestPath: null,
	filesWalked: 1,
}

interface FakeSession {
	locale: string
	closed: boolean
	artifacts: { lexicons: Record<string, never> }
	[Symbol.asyncDispose](): Promise<void>
}

const builds: Array<{ locale: string; ready: PromiseWithResolvers<GeocodeSession> }> = []

/**
 * A registry whose builds wait for the test to settle them, so a case controls which acquires overlap.
 */
function registryOf(maxResident: number): EngineRegistry {
	return new EngineRegistry("/repo", maxResident, FINGERPRINT, {
		computeFingerprint: async () => FINGERPRINT,
		createSession: (options) => {
			const ready = Promise.withResolvers<GeocodeSession>()

			builds.push({ locale: options.locale, ready })

			return ready.promise
		},
	})
}

/**
 * The fake as the registry reads it.
 * The registry reads only `artifacts` and the disposer.
 */
function asSession(fake: unknown): GeocodeSession {
	return fake as GeocodeSession
}

function fakeSession(locale: string): FakeSession {
	const session: FakeSession = {
		locale,
		closed: false,
		artifacts: { lexicons: {} },
		async [Symbol.asyncDispose]() {
			session.closed = true
		},
	}

	return session
}

/**
 * Settles the oldest unsettled build with a fresh session and returns that session.
 */
async function finishBuild(): Promise<FakeSession> {
	await vi.waitFor(() => expect(builds.length).toBeGreaterThan(0))

	const build = builds.shift()!
	const session = fakeSession(build.locale)

	build.ready.resolve(asSession(session))

	return session
}

beforeEach(() => {
	builds.length = 0
})

describe("EngineRegistry", () => {
	it("builds one session for concurrent acquires of one configuration", async () => {
		const registry = registryOf(2)
		const first = registry.acquire({ locale: "en-US" })
		const second = registry.acquire({ locale: "en-US" })
		const session = await finishBuild()

		using a = await first
		using b = await second

		expect(a.session).toBe(session)
		expect(b.session).toBe(session)
		expect(builds).toEqual([])
		expect(registry.size).toBe(1)
	})

	it("closes an evicted engine's session only once its last lease is released", async () => {
		const registry = registryOf(1)
		const pending = registry.acquire({ locale: "en-US" })
		const usSession = await finishBuild()
		const us = await pending

		// A second configuration pushes the first out of a one-engine cache while the first is still leased.
		const gbPending = registry.acquire({ locale: "en-GB" })

		await finishBuild()

		using _gb = await gbPending

		expect(registry.size).toBe(1)
		expect(usSession.closed).toBe(false)

		us[Symbol.dispose]()

		await vi.waitFor(() => expect(usSession.closed).toBe(true))
	})

	it("closes every session on evictAll, held or not", async () => {
		const registry = registryOf(2)
		const pending = registry.acquire({ locale: "en-US" })
		const session = await finishBuild()

		using _held = await pending

		await expect(registry.evictAll()).resolves.toBe(1)
		expect(session.closed).toBe(true)
	})

	it("builds again after a failed build", async () => {
		const registry = registryOf(2)
		const failing = registry.acquire({ locale: "en-US" })

		await vi.waitFor(() => expect(builds).toHaveLength(1))
		builds.shift()!.ready.reject(new Error("weights missing"))

		await expect(failing).rejects.toThrow("weights missing")

		const retry = registry.acquire({ locale: "en-US" })
		const session = await finishBuild()

		using engine = await retry

		expect(engine.session).toBe(session)
	})
})

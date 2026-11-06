// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { afterEach, describe, expect, test, vi } from "vitest"

import { isTransientResourceError, resourceErrorKind } from "#api/responses"
import {
	OfflineReason,
	offlineReason,
	offlineResourceError,
	readNavigatorOnline,
	UNKNOWN_CONNECTIVITY,
} from "#network/connectivity"

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("readNavigatorOnline", () => {
	test("reads navigator.onLine when the runtime defines it", () => {
		vi.stubGlobal("navigator", { onLine: false })
		expect(readNavigatorOnline()).toBe(false)

		vi.stubGlobal("navigator", { onLine: true })
		expect(readNavigatorOnline()).toBe(true)
	})

	test("reads unknown when navigator lacks onLine, as in Node and workerd", () => {
		vi.stubGlobal("navigator", { userAgent: "Node.js" })
		expect(readNavigatorOnline()).toBeNull()

		vi.stubGlobal("navigator", undefined)
		expect(readNavigatorOnline()).toBeNull()
	})
})

describe("offlineReason", () => {
	test("rules out a request only on a reading of false", () => {
		expect(offlineReason(UNKNOWN_CONNECTIVITY)).toBeNull()
		expect(offlineReason({ online: true, reachable: true })).toBeNull()
		expect(offlineReason({ online: true, reachable: null })).toBeNull()
		expect(offlineReason({ online: false, reachable: null })).toBe(OfflineReason.Offline)
		expect(offlineReason({ online: false, reachable: true })).toBe(OfflineReason.Offline)
		expect(offlineReason({ online: true, reachable: false })).toBe(OfflineReason.Unreachable)
		expect(offlineReason({ online: null, reachable: false })).toBe(OfflineReason.Unreachable)
	})
})

describe("offlineResourceError", () => {
	test("is a transient 503 of kind network that keeps its cause", () => {
		const cause = new TypeError("Failed to fetch")
		const error = offlineResourceError(OfflineReason.Unreachable, cause)

		expect(error.status).toBe(503)
		expect(error.name).toBe("connectivity:network:service-unreachable")
		expect(resourceErrorKind(error)).toBe("network")
		expect(isTransientResourceError(error)).toBe(true)
		expect(error.cause).toBe(cause)
	})
})

// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, test } from "vitest"

import { isSkipWaitingMessage } from "#skip-waiting"

describe("isSkipWaitingMessage", () => {
	test("reads the message workbox-window posts and refuses others", () => {
		expect(isSkipWaitingMessage({ type: "SKIP_WAITING" })).toBe(true)
		expect(isSkipWaitingMessage({ type: "mailwoman-prune-db-ranges", keepVersion: "v10.8.0" })).toBe(false)
		expect(isSkipWaitingMessage("SKIP_WAITING")).toBe(false)
		expect(isSkipWaitingMessage(null)).toBe(false)
	})
})

// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { ServiceRegistry } from "async-init"
import { describe, expect, test } from "vitest"

import { AbortKind, abortKindOf, AbortReason } from "#abort"

describe("abortKindOf", () => {
	test("answers null while the signal has not aborted", () => {
		expect(abortKindOf(new AbortController().signal)).toBeNull()
	})

	test("answers the kind of an AbortReason", () => {
		const controller = new AbortController()

		controller.abort(new AbortReason(AbortKind.Superseded))

		expect(abortKindOf(controller.signal)).toBe(AbortKind.Superseded)
	})

	test("answers caller for the platform's default reason and for an untyped one", () => {
		const bare = new AbortController()
		const untyped = new AbortController()

		bare.abort()
		untyped.abort(new Error("the reader left the page"))

		expect(abortKindOf(bare.signal)).toBe(AbortKind.Caller)
		expect(abortKindOf(untyped.signal)).toBe(AbortKind.Caller)
	})

	test("answers deadline for AbortSignal.timeout, alone and combined with a caller's signal", async () => {
		const caller = new AbortController()
		const deadline = AbortSignal.timeout(1)
		const combined = AbortSignal.any([caller.signal, deadline])

		await new Promise<void>((resolve) => {
			deadline.addEventListener("abort", () => resolve(), { once: true })
		})

		expect(abortKindOf(deadline)).toBe(AbortKind.Deadline)
		expect(abortKindOf(combined)).toBe(AbortKind.Deadline)
	})

	test("answers the caller's kind when the caller aborts before the deadline", () => {
		const caller = new AbortController()
		const combined = AbortSignal.any([caller.signal, AbortSignal.timeout(60_000)])

		caller.abort()

		expect(abortKindOf(combined)).toBe(AbortKind.Caller)
	})

	test("answers scope-disposed for the signal of a disposed async-init registry", async () => {
		const registry = new ServiceRegistry()

		await registry.dispose()

		expect(abortKindOf(registry.signal)).toBe(AbortKind.ScopeDisposed)
	})
})

describe("AbortReason", () => {
	test("is named AbortError, with its kind and a default message", () => {
		const reason = new AbortReason(AbortKind.Deadline)

		expect(reason).toMatchObject({ name: "AbortError", kind: AbortKind.Deadline })
		expect(reason.message).not.toBe("")
	})
})

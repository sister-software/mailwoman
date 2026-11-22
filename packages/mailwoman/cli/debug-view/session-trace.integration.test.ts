// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   This test checks a `trace: true` session against the real classifier.
 *
 *   It checks the recorded data and confirms that tracing leaves the answer unchanged.
 *   The debug view exists for inspection.
 *
 *   If tracing the decode moved a coordinate, the view would measure a different pipeline.
 *
 *   Guarded on the same prerequisites as `static.test.ts` (weights + a WOF admin distribution),
 *   and skipping for the same reasons, so the two suites run and skip together.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolveWeights } from "@mailwoman/neural/weights"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { describe, expect, test } from "vitest"

import { $public } from "#env"
import { createGeocodeSessionOptions, createGeocodeSession } from "#geocode"

const DEFAULT_WOF_PATH = wofDatabasePath("admin-global-priority.db")
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH
const hasWOFDB = await pathExists(wofPath)

const hasWeights = await (async () => {
	try {
		await resolveWeights({ locale: "en-us" })

		return true
	} catch {
		return false
	}
})()

const ADDRESS = "3215 SE Clinton St, Portland OR"
const TEST_TIMEOUT_MS = 120_000

describe.skipIf(!(hasWOFDB && hasWeights))("geocode session tracing", () => {
	test(
		"records the decode that produced the tree, and resolves the same answer as an untraced session",
		async () => {
			const options = createGeocodeSessionOptions()
			const traced = await createGeocodeSession({ ...options, trace: true })
			const plain = await createGeocodeSession(options)

			try {
				const withTrace = await traced.geocode(ADDRESS)
				const without = await plain.geocode(ADDRESS)

				// The answer is the answer, traced or not.
				// The one field a trace adds is the derivation projected from the records the sink received.
				// It is null, rather than empty, on the untraced path.
				const { derivation, ...tracedResult } = withTrace.result

				expect(derivation).not.toBeNull()
				expect(without.result.derivation).toBeNull()
				expect({ ...tracedResult, derivation: null }).toEqual(without.result)
				expect(withTrace.tree).toEqual(without.tree)

				// An untraced session records no trace — absent rather than an empty one.
				expect(without.trace).toBeUndefined()

				const trace = withTrace.trace

				if (!trace) throw new Error("expected a trace from a session opened with trace: true")

				// The trace is about the same text the tree was built from (post Stage-1 normalize).
				expect(trace.parse.text).toBe(withTrace.tree.raw)
				expect(trace.parse.pieces.length).toBeGreaterThan(0)
				expect(trace.parse.tokens).toHaveLength(trace.parse.pieces.length)

				// And the decode it recorded is the decode behind the tree: every component the
				// tree appears at the top level as a label the trace's tokens produced.
				const decoded = new Set(trace.parse.tokens.map((token) => token.label.replace(/^[BI]-/u, "")))

				for (const root of withTrace.tree.roots) {
					expect(decoded.has(root.tag)).toBe(true)
				}

				// The structural stages that fed the parse rode along.
				expect(trace.inputMode).toBe("formatted")
				expect(trace.kind?.kind).toBe("structured_address")

				// Both runs state the locale and scope they answered under, traced or not.
				expect(withTrace.applied).toEqual({
					locale: { locale: options.locale, source: "default" },
					countryScope: { resolver: { country: "US", source: "inferred", strength: "hard" }, withheld: null },
				})

				expect(without.applied).toEqual(withTrace.applied)

				// Both paths report the same timing phases: the trace comes from the answer's
				// own decode, so a traced run has no phase of its own to time.
				expect(withTrace.timing.total).toBeGreaterThan(0)
				expect(withTrace.timing.trace).toBeUndefined()
				expect(without.timing.trace).toBeUndefined()
				expect(withTrace.faults).toEqual([])
			} finally {
				await traced[Symbol.asyncDispose]()
				await plain[Symbol.asyncDispose]()
			}
		},
		TEST_TIMEOUT_MS
	)

	test(
		"traces the text the tree was decoded from when the input opens with a postal mark",
		async () => {
			await using traced = await createGeocodeSession({ ...createGeocodeSessionOptions(), trace: true })

			// The character-path classifier keeps the mark the SentencePiece one strips.
			// The trace is of the answer's own decode, so it reads the text the routed classifier read.
			const run = await traced.geocode("〒100-0001 東京都千代田区千代田1-1")

			expect(run.trace?.parse.text).toBe(run.tree.raw)
		},
		TEST_TIMEOUT_MS
	)
})

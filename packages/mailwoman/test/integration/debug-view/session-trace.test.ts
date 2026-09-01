/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `trace: true` session, against the real classifier: what it records, and — the required half — that
 *   recording it changes no answer. The debug view is an INSPECTION surface; the moment its extra decode could move a
 *   coordinate, every reading taken through it would be about a different pipeline than the one that ships.
 *
 *   Guarded on the same prerequisites as `static.test.ts` (weights + a WOF admin distribution), and skipping for the
 *   same reasons, so the two suites run and skip together.
 */

import { $public } from "@mailwoman/core/env"
import { pathExists } from "@mailwoman/core/fs/readers"
import { dataRootPath } from "@mailwoman/core/utils"
import { resolveWeights } from "@mailwoman/neural/weights"
import { createGeocodeCommandOptions, createGeocodeSession } from "mailwoman/geocode"
import { describe, expect, test } from "vitest"

const DEFAULT_WOF_PATH = String(dataRootPath("wof", "admin-global-priority.db"))
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
			const options = createGeocodeCommandOptions()
			const traced = await createGeocodeSession({ ...options, trace: true })
			const plain = await createGeocodeSession(options)

			try {
				const withTrace = await traced.geocode(ADDRESS)
				const without = await plain.geocode(ADDRESS)

				// The answer is the answer, traced or not.
				expect(withTrace.result).toEqual(without.result)
				expect(withTrace.tree).toEqual(without.tree)

				// An untraced session records no trace — absent, not an empty one.
				expect(without.trace).toBeUndefined()

				const trace = withTrace.trace

				if (!trace) throw new Error("expected a trace from a session opened with trace: true")

				// The trace is about the SAME text the tree was built from (post Stage-1 normalize).
				expect(trace.parse.text).toBe(withTrace.tree.raw)
				expect(trace.parse.pieces.length).toBeGreaterThan(0)
				expect(trace.parse.tokens).toHaveLength(trace.parse.pieces.length)

				// And the decode it recorded is the decode behind the tree: every component the tree carries at the
				// top level appears as a label the trace's tokens actually produced.
				const decoded = new Set(trace.parse.tokens.map((token) => token.label.replace(/^[BI]-/u, "")))

				for (const root of withTrace.tree.roots) {
					expect(decoded.has(root.tag)).toBe(true)
				}

				// The structural stages that fed the parse rode along.
				expect(trace.inputMode).toBe("formatted")
				expect(trace.kind?.kind).toBe("structured_address")
				expect(trace.locale).toBe(options.locale)

				// Timing is measured on both paths, and the traced one accounts for its extra decode.
				expect(withTrace.timing.total).toBeGreaterThan(0)
				expect(withTrace.timing.trace).toBeGreaterThan(0)
				expect(without.timing.trace).toBeUndefined()
			} finally {
				traced[Symbol.dispose]()
				plain[Symbol.dispose]()
			}
		},
		TEST_TIMEOUT_MS
	)
})

// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { type LoadLedgerSnapshot, SERVED_FROM_HEADER } from "@mailwoman/core/load-ledger"
import { afterEach, describe, expect, test, vi } from "vitest"

import { artifactSource, LoadLedger, roleOfArtifactURL } from "#browser-runtime/artifact-ledger"

const BASE = "https://public.mailwoman.post/mailwoman/en-us/v10.8.0/"

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("roleOfArtifactURL", () => {
	test("reads each published file name as its role", () => {
		expect(
			[
				"model.onnx",
				"encoder.onnx",
				"embeddings-hot.bin",
				"tokenizer.model",
				"char-vocab.json",
				"anchor-lexicon-v1.json",
				"model-card.json",
				"calibration.json",
				"fst-en-US.bin",
				"postcode-gb.bin",
			].map((file) => roleOfArtifactURL(`${BASE}${file}`))
		).toEqual([
			"weights",
			"weights",
			"embeddings",
			"tokenizer",
			"lexicon",
			"lexicon",
			"model-card",
			"calibration",
			"fst",
			"postcode",
		])

		expect(roleOfArtifactURL("https://public.mailwoman.post/mailwoman/pair-index/2026-09/pair-index-gb.bin")).toBe(
			"pair-index"
		)

		expect(roleOfArtifactURL("https://public.mailwoman.post/mailwoman/gazetteer/2026-08-25b/candidate.db")).toBe(
			"gazetteer"
		)

		expect(roleOfArtifactURL("https://earth.mailwoman.post/assets/ort-wasm-simd-threaded.wasm")).toBe("ort-wasm")
	})
})

describe("artifactSource", () => {
	test("reads the service worker's header first, then the browser's resource timing", () => {
		const url = `${BASE}model.onnx`
		const entries = new Map<string, unknown[]>()

		vi.stubGlobal("performance", { getEntriesByName: (name: string) => entries.get(name) ?? [] })

		expect(artifactSource(url, new Response("", { headers: { [SERVED_FROM_HEADER]: "service-worker" } }))).toBe(
			"service-worker"
		)

		expect(artifactSource(url, new Response(""))).toBe("unknown")

		entries.set(url, [{ deliveryType: "cache", transferSize: 0 }])
		expect(artifactSource(url, new Response(""))).toBe("http-cache")

		entries.set(url, [{ deliveryType: "", transferSize: 31_000_000 }])
		expect(artifactSource(url, new Response(""))).toBe("network")
	})
})

describe("LoadLedger", () => {
	test("notifies on each state change and at most once per 100 ms for byte counts", () => {
		vi.useFakeTimers()

		const snapshots: LoadLedgerSnapshot[] = []
		const ledger = new LoadLedger((snapshot) => snapshots.push(snapshot))
		const url = `${BASE}model.onnx`

		ledger.start(url)

		for (let received = 1; received <= 10; received++) {
			ledger.bytes(url, received * 1000, 10_000)
		}

		vi.advanceTimersByTime(100)
		ledger.bytes(url, 10_000, 10_000)
		ledger.settle(url, { state: "done", source: "network", error: null })

		// One start, one throttled byte notice, one after the interval, one settle.
		expect(snapshots).toHaveLength(4)

		expect(snapshots.at(-1)?.entries).toEqual([
			{ role: "weights", url, received: 10_000, total: 10_000, source: "network", state: "done", error: null },
		])
	})
})

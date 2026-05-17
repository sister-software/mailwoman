/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { BIO_LABELS, COMPONENT_TAGS } from "@mailwoman/core/types"
import { describe, expect, it } from "vitest"
import type { AdapterOptions, CanonicalRow, CorpusAdapter, LabeledRow, QuarantinedRow } from "./types.js"

describe("corpus types", () => {
	it("CanonicalRow accepts every COMPONENT_TAG as a component key", () => {
		const components: CanonicalRow["components"] = {}
		for (const tag of COMPONENT_TAGS) {
			components[tag] = `value for ${tag}`
		}
		const row: CanonicalRow = {
			raw: "1600 Pennsylvania Ave NW, Washington, DC 20500, USA",
			components,
			country: "US",
			locale: "en-US",
			source: "test-fixture",
			source_id: "row-1",
			corpus_version: "0.1.0",
			license: "CC0-1.0",
		}
		expect(row.components.country).toBe("value for country")
		expect(row.components.postcode).toBe("value for postcode")
	})

	it("synth marker is optional, carries method + base_source_id when present", () => {
		const natural: CanonicalRow = {
			raw: "Paris",
			components: { locality: "Paris" },
			country: "FR",
			locale: "fr-FR",
			source: "wof-admin",
			source_id: "wof-101751119",
			corpus_version: "0.1.0",
			license: "CC0-1.0",
		}
		const synth: CanonicalRow = {
			...natural,
			raw: "PARIS",
			source_id: "wof-101751119+case-upper",
			synth: { method: "case-perturb:upper", base_source_id: "wof-101751119" },
		}
		expect(natural.synth).toBeUndefined()
		expect(synth.synth?.method).toBe("case-perturb:upper")
		expect(synth.synth?.base_source_id).toBe("wof-101751119")
	})

	it("LabeledRow extends CanonicalRow with parallel token/label arrays of equal length", () => {
		const labels = BIO_LABELS.slice(0, 3)
		const row: LabeledRow = {
			raw: "Paris",
			components: { locality: "Paris" },
			country: "FR",
			source: "wof-admin",
			source_id: "wof-101751119",
			corpus_version: "0.1.0",
			license: "CC0-1.0",
			tokens: ["▁Pa", "ri", "s"],
			labels,
		}
		expect(row.tokens.length).toBe(row.labels.length)
		expect(row.labels[0]).toBe(BIO_LABELS[0])
	})

	it("QuarantinedRow wraps a CanonicalRow with a human-readable reason", () => {
		const q: QuarantinedRow = {
			row: {
				raw: "??? unknown",
				components: { locality: "Paris" },
				country: "FR",
				source: "wof-admin",
				source_id: "wof-99",
				corpus_version: "0.1.0",
				license: "CC0-1.0",
			},
			reason: "component-not-found:locality",
		}
		expect(q.reason).toMatch(/^component-not-found:/)
	})

	it("AdapterOptions has only an inputPath required", () => {
		const opts: AdapterOptions = { inputPath: "/tmp/fixture.db" }
		expect(opts.inputPath).toBeDefined()
		expect(opts.limit).toBeUndefined()
	})

	it("CorpusAdapter is implementable as an async generator", async () => {
		const adapter: CorpusAdapter = {
			id: "noop",
			defaultLicense: "CC0-1.0",
			description: "Smoke-test adapter that yields a single hand-crafted row.",
			async *rows(_opts) {
				yield {
					raw: "Paris",
					components: { locality: "Paris" },
					country: "FR",
					source: "noop",
					source_id: "noop-1",
					corpus_version: "",
					license: "CC0-1.0",
				}
			},
		}
		const collected: CanonicalRow[] = []
		for await (const row of adapter.rows({ inputPath: "" })) {
			collected.push(row)
		}
		expect(collected).toHaveLength(1)
		expect(collected[0]!.source).toBe("noop")
	})
})

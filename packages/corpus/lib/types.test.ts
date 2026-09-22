/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { BIO_LABELS, COMPONENT_TAGS } from "@mailwoman/codex/component"
import { SourceRegister } from "@mailwoman/corpus/registers"
import {
	AddressRole,
	addressRoleOf,
	DEFAULT_ADDRESS_ROLE,
	type AdapterOptions,
	type CanonicalRow,
	type CorpusAdapter,
	type LabeledRow,
	type QuarantinedRow,
	SurfaceOrigin,
} from "@mailwoman/corpus/types"
import { describe, expect, it } from "vitest"

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

	it("the recipe marker is optional, carries recipe + base_source_id when present", () => {
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

		const derived: CanonicalRow = {
			...natural,
			raw: "PARIS",
			source_id: "wof-101751119+case-upper",
			recipe: { recipe: "case-perturb:upper", base_source_id: "wof-101751119" },
		}

		expect(natural.recipe).toBeUndefined()
		expect(derived.recipe?.recipe).toBe("case-perturb:upper")
		expect(derived.recipe?.base_source_id).toBe("wof-101751119")
	})

	it("register and surface answer separate questions on one row", () => {
		const composed: CanonicalRow = {
			raw: "9 Pollard Close, London, E16 1LG",
			components: { house_number: "9", street: "Pollard Close", locality: "London", postcode: "E16 1LG" },
			country: "GB",
			source: "synth-gb",
			source_id: "ppd-1",
			corpus_version: "0.9.9",
			license: "OGL-UK-3.0",
			register: SourceRegister.LandRegistryPricePaid,
			surface: SurfaceOrigin.Composed,
		}

		const invented: CanonicalRow = {
			raw: "PO Box 120, Austin, TX 78701",
			components: { po_box: "PO Box 120", locality: "Austin", region: "TX", postcode: "78701" },
			country: "US",
			source: "synth-po-box",
			source_id: "po-1",
			corpus_version: "0.9.9",
			license: "CC0-1.0",
			register: null,
			surface: SurfaceOrigin.Invented,
		}

		// A template composed the first surface from fields HM Land Registry published,
		// so the row is a real address written in the recipe's order.
		// The second names no published record at all.
		expect(composed.register).toBe("gb-hm-land-registry-ppd")
		expect(composed.surface).toBe("composed")
		expect(invented.register).toBeNull()
		expect(invented.surface).toBe("invented")
	})

	it("addressRoleOf reads an absent role as the default and an explicit one verbatim", () => {
		const base: CanonicalRow = {
			raw: "PO Box 120, Austin, TX 78701",
			components: { po_box: "PO Box 120", locality: "Austin", region: "TX", postcode: "78701" },
			country: "US",
			source: "state-tx-notaries",
			source_id: "tx-1",
			corpus_version: "0.1.0",
			license: "US-PD",
		}

		expect(DEFAULT_ADDRESS_ROLE).toBe(AddressRole.Premise)
		expect(base.addressRole).toBeUndefined()
		expect(addressRoleOf(base)).toBe(AddressRole.Premise)
		expect(addressRoleOf({ ...base, addressRole: AddressRole.Mailing })).toBe("mailing")
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

		expect(row.tokens).toHaveLength(row.labels.length)
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
			addressRole: AddressRole.Premise,
			register: SourceRegister.WhosOnFirst,
			surface: SurfaceOrigin.Attested,
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

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The weights package's card, README and JSON layout. The card's phase and component assertions track the active
 *   label set rather than a historical stage.
 */

import { STAGE2_FINE_TAGS } from "@mailwoman/neural/labels"
import type { AddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"
import { describe, expect, test } from "vitest"

import {
	ACTIVE_BIO_LABELS,
	ACTIVE_TAGS,
	addressSystemCard,
	buildModelCard,
	componentsSupportedBlurb,
	type ModelCardInputs,
	noEvalReport,
	parseEvalReport,
	phaseLabel,
	packageFileText,
	pythonPathString,
	pythonUTCTimestamp,
	renderReadme,
	targetStatusLine,
} from "./package-weights.ts"

const registry: AddressSystemRegistry = {
	$comment: "",
	systems: [
		{ id: 0, key: "a" },
		{ id: 1, key: "b" },
		{ id: 2, key: "c" },
	],
	members: [
		{ country: "US", script: "local", system: 1 },
		{ country: "JP", script: "latin", system: 0 },
		{ country: "JP", script: "local", system: 2 },
	],
}

function inputs(overrides: Partial<ModelCardInputs> = {}): ModelCardInputs {
	return {
		locale: "en-us",
		corpusVersion: "0.3.0",
		tokenizerVersion: "0.1.0",
		trainingSteps: 50_000,
		evalReport: { per_component: {}, n_entries: 0 },
		notes: "",
		trainingHardware: "cpu-test",
		trainingDurationSeconds: 0,
		basePath: "/tmp/ck",
		packageVersion: "0.3.0",
		addressSystemCount: 0,
		addressSystems: null,
		completedAt: new Date("2026-10-29T18:30:00.000Z"),
		...overrides,
	}
}

describe("model card", () => {
	test("the phase names the active stage rather than the fallback", () => {
		expect(phaseLabel()).toContain("Stage 3")
		expect(phaseLabel().startsWith("Custom")).toBe(false)
	})

	test("lists every active component and the BIO labels in emission order", () => {
		const card = buildModelCard(inputs())

		expect(card["phase"]).toBe(phaseLabel())
		expect(card["components_supported"]).toEqual([...ACTIVE_TAGS])
		expect(card["labels"]).toEqual([...ACTIVE_BIO_LABELS])
		expect((card["labels"] as string[])[0]).toBe("O")

		for (const tag of STAGE2_FINE_TAGS) {
			expect(card["components_supported"]).toContain(tag)
		}
	})

	test("writes the address-system table only for a model with a head, holding only its ids", () => {
		expect(buildModelCard(inputs())).not.toHaveProperty("address_systems")

		expect(addressSystemCard(registry, 2)).toEqual({
			count: 2,
			no_hint: 2,
			members: { "JP/latin": 0, "US/local": 1 },
		})

		expect(() => buildModelCard(inputs({ addressSystemCount: 2 }))).toThrow(/registry/u)
	})

	test("writes the card tab-indented with a trailing newline", () => {
		const text = packageFileText(buildModelCard(inputs({ evalReport: noEvalReport() })))

		expect(text).toContain('\t\t"duration_seconds": 0,')
		expect(text).toContain('"full_parse_exact_match": 0,')
		expect(text).toContain('"started_at": null,')
		expect(text.endsWith("}\n")).toBe(true)
	})

	test("reads a report's numbers as numbers", () => {
		const text = packageFileText(parseEvalReport('{"a": 1.0, "b": 1, "c": 1e-05, "d": [0.5]}'))

		expect(text).toBe('{\n\t"a": 1,\n\t"b": 1,\n\t"c": 0.00001,\n\t"d": [\n\t\t0.5\n\t]\n}\n')
	})
})

describe("paths and times", () => {
	test("normalizes a path the way str(Path(p)) does", () => {
		expect(pythonPathString("./a//b/")).toBe("a/b")
		expect(pythonPathString("/a/./b/")).toBe("/a/b")
		expect(pythonPathString(".")).toBe(".")
	})

	test("writes utcnow().isoformat() with microseconds only when nonzero", () => {
		expect(pythonUTCTimestamp(new Date("2026-10-29T18:30:00.123Z"))).toBe("2026-10-29T18:30:00.123000Z")
		expect(pythonUTCTimestamp(new Date("2026-10-29T18:30:00.000Z"))).toBe("2026-10-29T18:30:00Z")
	})
})

describe("README", () => {
	test("the status line applies the fine-label floors", () => {
		const line = targetStatusLine({
			per_component: {
				country: { f1: 0.99 },
				venue: { f1: 0.65 },
				street: { f1: 0.55 },
				house_number: { f1: 0.95 },
			},
		})

		expect(line).toContain("street")
		expect(line).toContain("0.5500")
		expect(line).toContain("target ≥0.70")
		expect(line).not.toContain("0.6500")
	})

	test("names the phase and components, and warns only on a smoke build", () => {
		const base = {
			locale: "en-us",
			corpusVersion: "0.3.0",
			evalReport: noEvalReport(),
			trainingSteps: 50_000,
			trainingHardware: "gfx1103",
		}

		const readme = renderReadme({ ...base, smoke: false })

		expect(readme).toContain(phaseLabel())

		for (const tag of ["venue", "street", "house_number"]) {
			expect(readme).toContain(tag)
		}

		expect(readme).not.toContain("SMOKE BUILD")
		expect(renderReadme({ ...base, smoke: true })).toContain("SMOKE BUILD")
		expect(componentsSupportedBlurb()).toContain(STAGE2_FINE_TAGS[0])
	})
})

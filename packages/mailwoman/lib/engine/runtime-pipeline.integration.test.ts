// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { AddressClassifier } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { runFile } from "@mailwoman/core/scripting/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/values/json"
import { describe, expect, it, vi } from "vitest"

import { createRuntimePipeline } from "#engine/runtime-pipeline"
import { $public } from "#env"

function fakeClassifier(): AddressClassifier {
	return {
		parse: vi.fn(async (text: string) => ({
			raw: text,
			roots: [
				{
					tag: "country" as const,
					value: "US",
					start: 0,
					end: text.length,
					confidence: 0.9,
					children: [],
				},
			],
		})),
	}
}

function passthroughResolver(): Resolver {
	return { resolveTree: vi.fn(async (tree) => tree), artifactCoverage: null }
}

describe("createRuntimePipeline — wiring", () => {
	it("surfaces inferred machine locale and timezone when the query has no locale evidence", async () => {
		await using pipeline = createRuntimePipeline({
			machinePreferences: { locale: "en-GB", timeZone: "Europe/London" },
		})

		const result = await pipeline("Paris")

		expect(result.locale).toMatchObject({
			locale: "en-GB",
			source: "machine",
			evidence: { intlLocale: "en-GB", timeZone: "Europe/London" },
		})
	})

	it("can disable host inference for a server runtime", async () => {
		await using pipeline = createRuntimePipeline({ machinePreferences: "none" })
		const result = await pipeline("Paris")

		expect(result.locale).toMatchObject({ locale: "en-US", confidence: 0.3, source: "detected" })
	})

	it("runs normalize + queryShape + classifier + resolver in order", async () => {
		const classifier = fakeClassifier()
		const resolver = passthroughResolver()
		await using pipeline = createRuntimePipeline({ classifier, resolver })

		const result = await pipeline("350  5th Ave, New York, NY 10118", { locale: "en-US" })

		expect(result.normalized.normalized).toBe("350 5th Ave, New York, NY 10118")

		expect(result.queryShape.knownFormats.some((f) => f.format === "us_zip")).toBe(true)

		expect(result.locale.locale).toBe("en-US")
		expect(result.locale.source).toBe("caller")

		expect(classifier.parse).toHaveBeenCalled()
		expect(result.tree.roots).toHaveLength(1)

		expect(resolver.resolveTree).toHaveBeenCalled()

		expect(result.path).toBe("full")
	})

	it("threads precomputed QueryShape into classifier.parse", async () => {
		const classifier = fakeClassifier()
		await using pipeline = createRuntimePipeline({ classifier })

		await pipeline("10118")

		const sawUSZip = expect.arrayContaining([expect.objectContaining({ format: "us_zip" })])

		expect(classifier.parse).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				queryShape: expect.objectContaining({ knownFormats: sawUSZip }),
			})
		)
	})

	it("Runs without classifier (empty tree without throwing)", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("hello world")
		expect(result.tree.roots).toEqual([])
		expect(result.timing["normalize"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["query-shape"]).toBeGreaterThanOrEqual(0)
	})

	it("Preserves raw input through normalize → result.input", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("  350  5th Ave  ")
		expect(result.input).toBe("  350  5th Ave  ")

		expect(result.normalized.raw).toBe("  350  5th Ave  ")

		expect(result.normalized.normalized).toBe("350 5th Ave")
	})

	it("offsetMap on normalized input lets consumers map back to raw chars", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("350  5th Ave")

		const map = (result.normalized as { offsetMap?: number[] }).offsetMap
		expect(map).toBeDefined()
		expect(map?.[4]).toBe(5)
	})

	it("locale check override is respected", async () => {
		const customDetect = vi.fn(async () => ({
			locale: "fr-FR",
			confidence: 0.92,
			alternatives: [],
			source: "detected" as const,
			script: [],
			evidence: null,
		}))

		await using pipeline = createRuntimePipeline({ detectLocale: customDetect })

		const result = await pipeline("8 rue Lafayette")
		expect(customDetect).toHaveBeenCalled()
		expect(result.locale.locale).toBe("fr-FR")
		expect(result.locale.source).toBe("detected")
	})
})

describe("createRuntimePipeline — kind classifier defaults", () => {
	it("classifies a bare US ZIP as postcode_only", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("10118")
		expect(result.kind.kind).toBe("postcode_only")
		expect(result.kind.confidence).toBeGreaterThan(0.5)
	})

	it("classifies a single-word input as locality_only", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("Paris")
		expect(result.kind.kind).toBe("locality_only")
	})

	it("classifies a multi-segment address as structured_address", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("350 5th Ave, New York, NY 10118")
		expect(result.kind.kind).toBe("structured_address")
	})

	it("classifies PO Box input as po_box", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("PO Box 1234")
		expect(result.kind.kind).toBe("po_box")
	})

	it("classifies 'Behind the gas station' as landmark", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("Behind the gas station")
		expect(result.kind.kind).toBe("landmark")
	})

	it("classifies '5th and Main' as intersection", async () => {
		await using pipeline = createRuntimePipeline({})
		const result = await pipeline("5th and Main")
		expect(result.kind.kind).toBe("intersection")
	})

	it("Fast-paths unambiguous postcode (US ZIP+4) inputs to resolver, skipping classifier", async () => {
		const classifier = fakeClassifier()
		const resolver = passthroughResolver()
		await using pipeline = createRuntimePipeline({ classifier, resolver })
		const result = await pipeline("10118-1234")
		expect(result.path).toBe("fast-path")
		expect(classifier.parse).not.toHaveBeenCalled()
		expect(resolver.resolveTree).toHaveBeenCalled()
	})

	it("does NOT fast-path ambiguous 5-digit input (US/FR/DE overlap)", async () => {
		const classifier = fakeClassifier()
		const resolver = passthroughResolver()
		await using pipeline = createRuntimePipeline({ classifier, resolver })
		const result = await pipeline("10118")
		expect(result.kind.kind).toBe("postcode_only")
		expect(result.path).toBe("full")
		expect(classifier.parse).toHaveBeenCalled()
	})

	it("custom classifyKind opt overrides the default", async () => {
		const customKind = vi.fn(async () => ({
			kind: "vague" as const,
			confidence: 0.5,
			alternatives: [],
			intentMarkers: null,
		}))

		await using pipeline = createRuntimePipeline({ classifyKind: customKind })
		const result = await pipeline("Paris")
		expect(customKind).toHaveBeenCalled()
		expect(result.kind.kind).toBe("vague")
	})
})

/**
 * CI runs under one machine locale, set in `.github/workflows/test.yml`.
 *
 * These cases run the default pipeline under a second one, so a dependence on the first shows here.
 */
describe.skipIf(Boolean($public.MW_LOCALE))("createRuntimePipeline — under a second machine locale", () => {
	const MACHINE_LOCALES = ["en-US", "fr-FR"] as const
	const pipelineUnder = (locale: string) => createRuntimePipeline({ machinePreferences: { locale } })

	it("detects the same locale from an input's own script or postcode on either machine", async () => {
		for (const input of ["東京都千代田区丸の内1-1", "75008", "SW1A 1AA"]) {
			const [first, second] = await Promise.all(MACHINE_LOCALES.map((locale) => pipelineUnder(locale)(input)))

			expect(first!.locale.source, input).toBe("detected")
			expect(second!.locale, input).toEqual(first!.locale)
		}
	})

	it("gives an input with no such evidence the machine's locale, and states the machine supplied it", async () => {
		for (const machine of MACHINE_LOCALES) {
			const result = await pipelineUnder(machine)("12 Main Street")

			expect(result.locale).toMatchObject({
				locale: machine,
				source: "machine",
				evidence: { intlLocale: machine, environmentLocale: null },
			})
		}
	})

	it("reads the machine's locale from the environment the process started under", async () => {
		// Node fixes `Intl`'s default locale at startup, so the real read needs a process of its own.
		const script =
			`const { createRuntimePipeline } = await import(${stringifyJSON(import.meta.resolve("#engine/runtime-pipeline"))});` +
			`const result = await createRuntimePipeline()("12 Main Street");` +
			`console.log(JSON.stringify(result.locale));`

		const { stdout } = await runFile(process.execPath, ["--input-type=module", "-e", script], {
			env: childEnv({ LC_ALL: "fr_FR.UTF-8", MW_LOCALE: null }),
		})

		expect(parseJSONStrict(stdout)).toMatchObject({
			locale: "fr-FR",
			source: "machine",
			evidence: { intlLocale: "fr-FR" },
		})
	}, 60_000)
})

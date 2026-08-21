/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wire contract for the releases manifest, post-migration (2026-07-04). History: the acronym
 *   sweep capitalized the manifest READS while the published R2 json kept the legacy keys — every
 *   release read `undefined`, silently disabling the demo's WOF cascade and FST for three days.
 *   The resolution keeps the house casing and migrates the WIRE: the publisher writes
 *   `hasFST`/`hasWOFDB`, `normalizeReleasesManifest` is the single boundary that tolerates BOTH
 *   key generations (old HF mirrors still carry `hasFst`/`hasWofDb`), and no consumer reads raw
 *   wire keys outside it.
 */

import { readFileSync } from "node:fs"

import { normalizeReleasesManifest } from "@mailwoman/docs/shared/demo-helpers"
import { describe, expect, test } from "vitest"

import type { WireReleaseEntry } from "#shared/demo-helpers"

const entry = (over: Partial<WireReleaseEntry>) => ({
	version: "vX",
	label: "",
	description: "",
	modelSize: "1 MB",
	tokenizerVocab: 1,
	steps: 1,
	...over,
})

describe("normalizeReleasesManifest — the single wire boundary", () => {
	test("house-cased wire keys pass through", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "vX",
			releases: [entry({ hasFST: true, hasWOFDB: true })],
		})

		expect(m.releases[0]).toMatchObject({ hasFST: true, hasWOFDB: true })
	})

	test("legacy wire keys (pre-2026-07-04 manifests, old HF mirrors) normalize", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "vX",
			releases: [entry({ hasFst: true, hasWofDb: true })],
		})

		expect(m.releases[0]).toMatchObject({ hasFST: true, hasWOFDB: true })
	})

	test("house keys win when both generations appear", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "vX",
			releases: [entry({ hasFST: false, hasFst: true, hasWOFDB: false, hasWofDb: true })],
		})

		expect(m.releases[0]).toMatchObject({ hasFST: false, hasWOFDB: false })
	})

	test("absent keys default false, never undefined (the silent-disable failure mode)", () => {
		const m = normalizeReleasesManifest({ locale: "en-us", defaultVersion: "vX", releases: [entry({})] })

		expect(m.releases[0]!.hasFST).toBe(false)
		expect(m.releases[0]!.hasWOFDB).toBe(false)
	})
})

describe("no consumer reads raw legacy wire keys outside the boundary", () => {
	for (const rel of [
		"../../../../src/pages/demo/_runtime.ts",
		"../../../../src/contexts/DemoEmbed.tsx",
		"../../../../../packages/mailwoman/release-tools/publish-hf.ts",
	]) {
		test(`${rel} is house-cased only`, () => {
			const src = readFileSync(new URL(rel, import.meta.url), "utf8")

			expect(src).not.toContain("hasFst")
			expect(src).not.toContain("hasWofDb")
		})
	}

	test("the LIVE 2026-08-11 wire spelling hasWOFDb (WOF caps, lowercase b) normalizes — the four-day demo outage's pin", () => {
		const m = normalizeReleasesManifest({
			locale: "en-us",
			defaultVersion: "v9.1.0",
			releases: [entry({ hasFST: true, hasWOFDb: true })],
		})

		expect(m.releases[0]!.hasWOFDB).toBe(true)
	})
})

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The exclusion check refuses far more than it admits, and a fold is identified by what it computes.
 */

import { CoverageBasis, foldIdentity, requireExclusionBasis, supportsExclusion } from "@mailwoman/evidence"
import { describe, expect, it } from "vitest"

const BASE = {
	layer: "os-open-uprn",
	source: "os-open-uprn",
	vintage: "2026-08",
	h3Cell: 152_013_130_866_079,
	probeFold: "foldStreetSurface@v1",
	layerFold: "foldStreetSurface@v1",
}

describe("supportsExclusion", () => {
	it("admits designated and surveyed, refuses source_present and absent", () => {
		expect(supportsExclusion({ basis: CoverageBasis.Designated })).toBe(true)
		expect(supportsExclusion({ basis: CoverageBasis.Surveyed })).toBe(true)
		expect(supportsExclusion({ basis: CoverageBasis.SourcePresent })).toBe(false)
		expect(supportsExclusion({})).toBe(false)
		expect(supportsExclusion({ basis: null })).toBe(false)
	})
})

describe("requireExclusionBasis", () => {
	it("builds an exclusion when the cell is designated and the folds agree", () => {
		const e = requireExclusionBasis({ ...BASE, cell: { basis: CoverageBasis.Designated } })

		expect(e).not.toBeNull()
		expect(e!.kind).toBe("exclusion")
		expect(e!.scope.basis).toBe("designated")
		expect(e!.scope.layer).toBe("os-open-uprn")
	})

	// The meaning-of-zero rule: a cell nobody surveyed is unknown, and unknown is not absence.
	it("refuses when the cell is missing from layer_coverage", () => {
		expect(requireExclusionBasis({ ...BASE, cell: undefined })).toBeNull()
	})

	it("refuses source_present — the source looked, which is not the source found everything", () => {
		expect(requireExclusionBasis({ ...BASE, cell: { basis: CoverageBasis.SourcePresent } })).toBeNull()
	})

	// The board's `locality=Tel Aviv-Yafo` class: the key "exists nowhere" only under the fold we probed with. An
	// exclusion here is confidently wrong and indistinguishable from a true absence.
	it("refuses when the probe fold differs from the layer's build fold", () => {
		expect(
			requireExclusionBasis({
				...BASE,
				layerFold: "normalizeLocalityForKey@v2",
				cell: { basis: CoverageBasis.Designated },
			})
		).toBeNull()
	})

	it("refuses when the country is outside the probe's scope", () => {
		expect(
			requireExclusionBasis({
				...BASE,
				country: "FR",
				countries: new Set(["GB"]),
				cell: { basis: CoverageBasis.Designated },
			})
		).toBeNull()
	})
})

describe("foldIdentity", () => {
	const resolverFold = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replaceAll(/[^a-z0-9 ]/gu, " ")
			.replaceAll(/\s+/gu, " ")
			.trim()

	const codexFold = (s: string) =>
		s
			.toLowerCase()
			.normalize("NFD")
			.replaceAll(/[\u0300-\u036F]/gu, "")
			.replaceAll(/[^a-z0-9]+/gu, " ")
			.trim()

	it("gives two same-named folds two different identities", () => {
		expect(foldIdentity(resolverFold)).not.toBe(foldIdentity(codexFold))
	})

	it("gives two independently written but equivalent folds the SAME identity", () => {
		const copy = (s: string) =>
			s
				.toLowerCase()
				.normalize("NFD")
				.replaceAll(/[\u0300-\u036F]/gu, "")
				.replaceAll(/[^a-z0-9]+/gu, " ")
				.trim()

		expect(foldIdentity(copy)).toBe(foldIdentity(codexFold))
	})

	it("is stable across calls", () => {
		expect(foldIdentity(codexFold)).toBe(foldIdentity(codexFold))
	})
})

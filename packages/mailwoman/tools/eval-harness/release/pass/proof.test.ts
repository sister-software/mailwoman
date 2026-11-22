// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import type { HeldoutDatasetEntry } from "#tools/eval-harness/heldout/dataset/manifest"
import type { ProvenanceRecord } from "#tools/eval-harness/heldout/per/country"
import { CURRENT_RELEASE_SPEC } from "#tools/eval-harness/release/current-spec"
import { passProofSpec, runPassProof } from "#tools/eval-harness/release/pass/proof"
import { readReleaseSpec } from "#tools/eval-harness/release/requirements"

type Entry = Pick<HeldoutDatasetEntry, "rowID" | "country" | "source" | "kind" | "group">

const spec = await readReleaseSpec(CURRENT_RELEASE_SPEC)

/**
 * `groups` two-row address groups in every country the specification requires,
 * and in every source a capability selects.
 */
function collection(groups: number, without: readonly string[] = []): Entry[] {
	const countries = new Set(spec.objective.countries)
	const sources = new Set<string>()

	for (const requirement of spec.requirements) {
		if (requirement.kind === "country") {
			countries.add(requirement.country)
		}

		if (requirement.kind === "capability") {
			for (const source of requirement.select?.sources ?? []) {
				sources.add(source)
			}
		}
	}

	const cells = [
		...[...countries].map((country) => ({ country, source: `oa-${country.toLowerCase()}` })),
		...[...sources].map((source) => ({ country: "US", source })),
	].filter((cell) => !without.includes(cell.country) && !without.includes(cell.source))

	return cells.flatMap((cell) =>
		Array.from({ length: groups * 2 }, (_, i): Entry => {
			const group = `${cell.source}-${Math.floor(i / 2)}`

			return {
				rowID: `${cell.source}:${group}#${i % 2}`,
				country: cell.country,
				source: cell.source,
				kind: "address",
				group,
			}
		})
	)
}

const unseen = (entries: readonly Entry[]) =>
	new Map(
		entries.map((entry) => [
			entry.rowID,
			{ provenance: "verified_unseen", evidence: "test" } satisfies ProvenanceRecord,
		])
	)

describe("runPassProof", () => {
	it("passes the arm above the published rate and not the arm at it, on a collection with enough groups", () => {
		const entries = collection(400)
		const report = runPassProof({ spec, entries, history: unseen(entries), seed: 1 })

		expect(report.arms[0]!.verdict.outcome).toBe("pass")
		expect(report.arms[1]!.verdict.outcome).not.toBe("pass")
		expect(report.proven).toBe(true)
	})

	it("isn't proven when an objective country holds no group, as a draw from an exhausted pool leaves it", () => {
		const entries = collection(400, ["US"])
		const report = runPassProof({ spec, entries, history: unseen(entries), seed: 1 })

		expect(report.arms[0]!.verdict.outcome).not.toBe("pass")
		expect(report.proven).toBe(false)
	})

	it("reads an unaudited row as unknown, which no check admits", () => {
		const entries = collection(400)
		const report = runPassProof({ spec, entries, history: new Map(), seed: 1 })

		expect(report.proven).toBe(false)
	})
})

describe("passProofSpec", () => {
	it("drops every tag selector, which needs labels, and gives the arms two distinct digests", () => {
		const { spec: proof, artifacts, tagSelectorsDropped } = passProofSpec(spec)

		expect(proof.requirements.some((requirement) => requirement.select?.withoutTags)).toBe(false)
		expect(tagSelectorsDropped).toEqual(spec.requirements.filter((r) => r.select?.withoutTags).map((r) => r.id))
		expect(artifacts.published).not.toBe(artifacts.candidate)
		expect(proof.identities.candidate.sha256).toBe(artifacts.candidate)
	})
})

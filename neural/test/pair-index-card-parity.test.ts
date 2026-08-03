/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every shipped `pair-index-<country>.bin` must agree with the model card that describes it.
 *
 *   WHY THIS EXISTS (2026-08-02). The en-gb card's pair-index block went stale at R2 and stayed
 *   stale through R3, R4b and R7 — three increments that each changed the artifact — still
 *   reporting the original PPD-only 19,209 pairs while the shipped binary had grown to 20,126. It
 *   was caught by hand during the Hugging Face staging, not by any gate, and only because the
 *   staging happened to compare them. Nothing in CI read both numbers.
 *
 *   The card is what a consumer, the release preflight and a future maintainer all read to learn
 *   what the artifact IS, so a card that disagrees with its binary is worse than no card: it is
 *   confidently wrong. This test makes the artifact itself the arbiter.
 *
 *   WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT. Pair COUNT and the calibrated `delta` /
 *   `transitionBeta` are compared, because those are properties of the CONTENT and a rebuild from
 *   the same sources reproduces them exactly. The card's `md5` is NOT compared: a PIX1 header
 *   embeds `buildDate`, so identical sources produce different bytes on every rebuild, and asserting
 *   on it would fail constantly for a reason that is not a defect. The md5 documents the artifact
 *   STAGED for a release; the release-side gate in `scripts/verify-release-metadata.ts` is where
 *   staged bytes get checked.
 *
 *   Skips per-package when the binary is absent — these are derived artifacts, gitignored and built
 *   by each package's `link-dev-weights.ts`, so a lean checkout legitimately has none.
 */

import { existsSync, readFileSync } from "node:fs"

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

/**
 * Which weights package ships which country's index, and where that package's card describes it.
 *
 * The card key is spelled out per package rather than discovered, because the naming is genuinely inconsistent across
 * the four (`us_artifacts` / `fr_artifacts` / `gb_artifacts` / `nz_artifacts`, each with its own `pair_index_<cc>_bin`
 * child). A guard that GUESSED the key would silently pass on a card whose block had been renamed or dropped — the
 * exact failure it exists to catch — so the mapping is explicit and a missing block is a failure, not a skip.
 */
const PACKAGES = [
	{ pkg: "neural-weights-en-us", country: "us", cardKeys: ["us_artifacts", "pair_index_us_bin"] },
	{ pkg: "neural-weights-fr-fr", country: "fr", cardKeys: ["fr_artifacts", "pair_index_fr_bin"] },
	{ pkg: "neural-weights-en-gb", country: "gb", cardKeys: ["gb_artifacts", "pair_index_gb_bin"] },
	{ pkg: "neural-weights-de-de", country: "de", cardKeys: ["de_artifacts", "pair_index_de_bin"] },
	{ pkg: "neural-weights-en-in", country: "in", cardKeys: ["in_artifacts", "pair_index_in_bin"] },
	{ pkg: "neural-weights-es-es", country: "es", cardKeys: ["es_artifacts", "pair_index_es_bin"] },
	{ pkg: "neural-weights-it-it", country: "it", cardKeys: ["it_artifacts", "pair_index_it_bin"] },
	{ pkg: "neural-weights-en-nz", country: "nz", cardKeys: ["nz_artifacts", "pair_index_nz_bin"] },
] as const

interface PairIndexFacts {
	pairs: number
	delta: number
	transitionBeta: number | undefined
	bytes: number
}

/**
 * Read a PIX1 binary's header and entry count without constructing a resolver — this test cares about what the FILE
 * says, so it deliberately does not route through the reader that a bug could also affect.
 */
function readPairIndexFacts(path: string): PairIndexFacts {
	const bytes = readFileSync(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// "PIX1" little-endian.
	const MAGIC = 0x31_58_49_50

	expect(view.getUint32(0, true), `${path} is not a PIX1 artifact`).toBe(MAGIC)

	const headerLen = view.getUint32(4, true)

	const header = JSON.parse(bytes.subarray(8, 8 + headerLen).toString("utf8")) as {
		delta: number
		transitionBeta?: number
	}

	return {
		pairs: view.getUint32(8 + headerLen, true),
		delta: header.delta,
		transitionBeta: header.transitionBeta,
		bytes: bytes.length,
	}
}

describe("pair-index ↔ model-card parity", () => {
	for (const { pkg, country, cardKeys } of PACKAGES) {
		const binPath = String(repoRootPath(pkg, `pair-index-${country}.bin`))
		const cardPath = String(repoRootPath(pkg, "model-card.json"))

		test.skipIf(!existsSync(binPath))(`${pkg}: the card describes the artifact on disk`, () => {
			const card = JSON.parse(readFileSync(cardPath, "utf8")) as Record<string, unknown>
			const [outerKey, innerKey] = cardKeys
			const outer = card[outerKey] as Record<string, unknown> | undefined
			const block = outer?.[innerKey] as Record<string, unknown> | undefined

			expect(
				block,
				`${cardPath} has no ${outerKey}.${innerKey} block — a shipped artifact must be described`
			).toBeDefined()

			const facts = readPairIndexFacts(binPath)

			// Pair count is the load-bearing one: it is what changed, unnoticed, across three increments.
			expect(block!.pairs, `${pkg}: card pairs != artifact pairs — rebuild the artifact or update the card`).toBe(
				facts.pairs
			)

			// The calibrated magnitudes ride the header; a card claiming a delta the binary does not carry would
			// misdescribe the shipped behaviour, not just the shipped size.
			const cardDelta = String(block!.delta_calibration ?? "")

			expect(cardDelta, `${pkg}: card delta_calibration does not mention the artifact's δ=${facts.delta}`).toContain(
				`δ=${facts.delta}`
			)

			if (facts.transitionBeta !== undefined) {
				expect(
					`${cardDelta}${String(block!.transition_beta ?? "")}`,
					`${pkg}: artifact carries transitionBeta=${facts.transitionBeta} but the card does not record it`
				).toContain(String(facts.transitionBeta))
			}
		})
	}
})

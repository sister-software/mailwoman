/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Every shipped `pair-index-<country>.bin` must agree with the model card that describes it, with
 *   the artifact as the arbiter: pair count and the calibrated `delta`/`transitionBeta` are compared
 *   because a rebuild from the same sources reproduces them exactly, while the card's `md5` is not
 *   compared because a PIX1 header embeds `buildDate` and identical sources produce different bytes
 *   on every rebuild.
 *
 *   Skips per-package when the binary is absent, since a lean checkout legitimately has none.
 */

import { readLocalBuffer, readLocalJSONFile, pathExists } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, test } from "vitest"

/**
 * Shows which weights package ships each country's index and where its card describes the index.
 *
 * The card key is listed per package because the names differ.
 * A guessed key could silently pass when a card's block had been renamed or dropped.
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

const BIN_EXISTS = new Map<string, boolean>()

for (const { pkg, country } of PACKAGES) {
	BIN_EXISTS.set(pkg, await pathExists(repoRootPath(pkg, `pair-index-${country}.bin`)))
}

interface PairIndexFacts {
	pairs: number
	delta: number
	transitionBeta: number | undefined
	parentDelta: number | undefined
	bytes: number
}

/**
 * Read a PIX1 binary's header and entry count without constructing a resolver,
 * deliberately not routing through the reader a bug could also affect.
 */
async function readPairIndexFacts(path: string): Promise<PairIndexFacts> {
	const bytes = await readLocalBuffer(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// "PIX1" little-endian.
	const MAGIC = 0x31_58_49_50

	expect(view.getUint32(0, true), `${path} is not a PIX1 artifact`).toBe(MAGIC)

	const headerLen = view.getUint32(4, true)

	const header = parseJSONStrict<{
		delta: number
		transitionBeta?: number
		parentDelta?: number
	}>(bytes.subarray(8, 8 + headerLen).toString("utf8"))

	return {
		pairs: view.getUint32(8 + headerLen, true),
		delta: header.delta,
		transitionBeta: header.transitionBeta,
		parentDelta: header.parentDelta,
		bytes: bytes.length,
	}
}

describe("pair-index ↔ model-card parity", () => {
	for (const { pkg, country, cardKeys } of PACKAGES) {
		const binPath = repoRootPath(pkg, `pair-index-${country}.bin`)
		const cardPath = repoRootPath(pkg, "model-card.json")

		test.skipIf(!BIN_EXISTS.get(pkg))(`${pkg}: the card describes the artifact on disk`, async () => {
			const card = await readLocalJSONFile<Record<string, unknown>>(cardPath)
			const [outerKey, innerKey] = cardKeys
			const outer = card[outerKey] as Record<string, unknown> | undefined
			const block = outer?.[innerKey] as Record<string, unknown> | undefined

			expect(
				block,
				`${cardPath} has no ${outerKey}.${innerKey} block — a shipped artifact must be described`
			).toBeDefined()

			const facts = await readPairIndexFacts(binPath)

			expect(block!.pairs, `${pkg}: card pairs != artifact pairs — rebuild the artifact or update the card`).toBe(
				facts.pairs
			)

			// A card claiming a delta the binary does not contain would misdescribe the
			// shipped behaviour rather than just the shipped size.
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

			// The whole-edge parent bias is default-on for locales that have a board
			// and off (no header key) for other locales.
			// The test grades both directions: an omitted shipped parentDelta misdescribes
			// the behaviour, while a claimed one the artifact lacks is worse.
			// The assertion spells out `parentDelta=<n>` because δ and β are both 5 today,
			// so a substring match on "5" would pass on a card that never mentioned the parent at all.
			const parentClaim = `parentDelta=${facts.parentDelta}`

			if (facts.parentDelta === undefined) {
				expect(
					cardDelta,
					`${pkg}: card claims a parentDelta but the artifact carries none — the parent bias is OFF for this locale`
				).not.toContain("parentDelta=")
			} else {
				expect(
					cardDelta,
					`${pkg}: artifact carries ${parentClaim} but the card's delta_calibration does not record it`
				).toContain(parentClaim)
			}
		})
	}
})

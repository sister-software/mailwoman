/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gold-set sampling for adjudication. The programmatic entity truth
 *   (`nppes-dedup-benchmark.ts`) collapses only NPPES-flagged subparts (Is-Subpart plus parent
 *   LBN/TIN), so it cannot settle the genuinely ambiguous co-located collisions: distinct NPIs at
 *   one address with near-identical name text and no subpart flag for the same parent.
 *   NPI truth and programmatic rules may disagree on these pairs. A frozen
 *   adjudicated gold set must cover.
 *
 *   This scans the full TX registry without geocoding and writes each pair as a JSONL row containing
 *   both records' fields (org name, address, authorized official, taxonomy, subpart and parent
 *   flags) plus the programmatic verdict. An adjudicator (human or LLM-as-judge, flagged as such)
 *   can then label same real-world entity or not.
 *
 *   Run: `mailwoman registry gold-set-sample [--cap 200000] [--state TX] [--tau 0.7] [--n 300]
 *   [--out-jsonl <path>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONLFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { jaccard } from "@mailwoman/match"

import { colocatedDistinctPairs, scanColocatedProviders, stateOption } from "#tools/shared"

/**
 * Options for {@linkcode goldSetSample}.
 */
export interface GoldSetSampleOptions {
	/**
	 * Record-matcher sources directory.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * Providers sampled from the registry.
	 *
	 * Default 200000.
	 */
	cap?: number
	/**
	 * State filter.
	 *
	 * Default TX.
	 */
	state?: string
	/**
	 * Org-name Jaccard collision threshold.
	 *
	 * Default 0.7.
	 */
	tau?: number
	/**
	 * Adjudication sample size.
	 *
	 * Default 300.
	 */
	n?: number
	/**
	 * Write the sampled pairs here as jsonl (otherwise the first 10 print to stdout).
	 */
	outJSONL?: string
}

interface HardPair {
	npiA: string
	npiB: string
	orgA: string
	orgB: string
	address: string
	nameJaccard: number
	sameAuthorizedOfficial: boolean
	sameTaxonomy: boolean
	bothSubpartSameParent: boolean
	programmaticVerdict: "same-entity" | "distinct"
	adjudication: null
}

/**
 * Sample the hard co-located name-collision stratum for adjudication.
 */
export async function goldSetSample(
	options: GoldSetSampleOptions = {},
	report?: (line: string) => void
): Promise<{ hardPairs: number; sampled: number }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const CAP = options.cap ?? 200_000
	const STATE = stateOption(options)
	const TAU = options.tau ?? 0.7
	const N = options.n ?? 300
	const OUT = options.outJSONL || ""
	const REGISTRY = `${SOURCES}/nppes_npi-registry_20260607.tsv`

	report?.(`[A] streaming ${STATE} org providers (cap ${CAP})…`)
	const { byAddr, kept } = await scanColocatedProviders({ registryPath: REGISTRY, state: STATE, cap: CAP })
	report?.(`    ${kept} providers at ${byAddr.size} addresses`)

	const hard: HardPair[] = []

	for (const { a, b } of colocatedDistinctPairs(byAddr)) {
		const sim = jaccard(a.tokens, b.tokens)

		if (sim < TAU) continue
		const sameParent = a.subpart && b.subpart && a.parent === b.parent && a.parent !== "|"

		if (sameParent) continue
		const sameAuth = a.auth !== "" && a.auth === b.auth
		const sameTax = a.taxonomy !== "" && a.taxonomy === b.taxonomy

		hard.push({
			npiA: a.npi,
			npiB: b.npi,
			orgA: a.org,
			orgB: b.org,
			address: a.address,
			nameJaccard: Number(sim.toFixed(3)),
			sameAuthorizedOfficial: sameAuth,
			sameTaxonomy: sameTax,
			bothSubpartSameParent: false,
			// The verdict records what an entity-level rule would say, so adjudication can grade it.
			programmaticVerdict: sameAuth ? "same-entity" : "distinct",
			adjudication: null,
		})
	}

	report?.(`    ${hard.length} hard co-located name-collision pairs (non-flagged-subpart)`)

	// A deterministic stride sample avoids file-order bias in the adjudication set.
	const stride = Math.max(1, Math.floor(hard.length / N))
	const sample = hard.filter((_, i) => i % stride === 0).slice(0, N)
	report?.(`    sampling ${sample.length} (stride ${stride}) for adjudication`)

	if (OUT) {
		await writeLocalJSONLFile(sample, OUT)
		report?.(`[written] ${OUT}`)
	} else {
		for (const p of sample.slice(0, 10)) {
			console.log(stringifyJSON(p))
		}
	}

	return { hardPairs: hard.length, sampled: sample.length }
}

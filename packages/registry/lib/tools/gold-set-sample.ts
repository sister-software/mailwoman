/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Gold-set P3 (#625) — sample the HARD slice for adjudication. The programmatic entity truth
 *   (`nppes-dedup-benchmark.ts`) collapses only NPPES-FLAGGED subparts (Is-Subpart + parent
 *   LBN/TIN); it can't settle the genuinely-ambiguous co-located collisions: distinct NPIs at one
 *   address with near-identical names that are NOT flagged subparts of the same parent. Those are
 *   where NPI-truth and any programmatic rule disagree — exactly the pairs a frozen adjudicated
 *   gold set must cover.
 *
 *   This finds them (over the full TX registry, geocode-free — the shared co-location scan
 *   `dedup-ceiling.ts` also runs) and writes each as a JSONL row carrying BOTH records' fields (org
 *   name, address, authorized official, taxonomy, subpart/parent flags) plus the programmatic
 *   verdict, so an adjudicator (human or LLM-as-judge, flagged as such) can label "same real-world
 *   entity? yes/no" and we can MEASURE how often the programmatic truth matches judgment.
 *
 *   Run: `mailwoman registry gold-set-sample [--cap 200000] [--state TX] [--tau 0.7] [--n 300]
 *   [--out-jsonl <path>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { jaccard } from "@mailwoman/match"

import { colocatedDistinctPairs, scanColocatedProviders, stateOption } from "#tools/shared"

/**
 * Options for {@linkcode goldSetSample}.
 */
export interface GoldSetSampleOptions {
	/**
	 * Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * Providers sampled from the registry. Default 200000.
	 */
	cap?: number
	/**
	 * State filter. Default TX.
	 */
	state?: string
	/**
	 * Org-name Jaccard collision threshold. Default 0.7.
	 */
	tau?: number
	/**
	 * Adjudication sample size. Default 300.
	 */
	n?: number
	/**
	 * Write the sampled pairs here as JSONL (otherwise the first 10 print to stdout).
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
	adjudication: null // ← to be filled: "same-entity" | "distinct"
}

/**
 * Gold-set P3 (#625) — sample the HARD co-located name-collision slice for adjudication.
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

	// Hard pairs: co-located, name-similar (≥τ), DISTINCT NPIs that programmatic truth can't confidently
	// collapse (NOT subparts of the same parent). Tag the programmatic verdict so adjudication can grade it.
	const hard: HardPair[] = []

	for (const { a, b } of colocatedDistinctPairs(byAddr)) {
		const sim = jaccard(a.tokens, b.tokens)

		if (sim < TAU) continue
		const sameParent = a.subpart && b.subpart && a.parent === b.parent && a.parent !== "|"

		if (sameParent) continue // programmatic truth already collapses these — not the hard slice
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
			// Programmatic heuristic verdict (what an entity-level rule WOULD say, beyond the flagged
			// subparts): same authorized official ⇒ likely one org; different official + different
			// specialty ⇒ likely distinct. The whole point is to ADJUDICATE whether this is right.
			programmaticVerdict: sameAuth ? "same-entity" : "distinct",
			adjudication: null,
		})
	}

	report?.(`    ${hard.length} hard co-located name-collision pairs (non-flagged-subpart)`)

	// Deterministic spread sample of N (stride, not head — avoid file-order bias, the dedup-ceiling lesson).
	const stride = Math.max(1, Math.floor(hard.length / N))
	const sample = hard.filter((_, i) => i % stride === 0).slice(0, N)
	report?.(`    sampling ${sample.length} (stride ${stride}) for adjudication`)

	if (OUT) {
		await writeLocalTextFile(sample.map((p) => JSON.stringify(p)).join("\n") + "\n", OUT)
		report?.(`[written] ${OUT}`)
	} else {
		for (const p of sample.slice(0, 10)) {
			console.log(JSON.stringify(p))
		}
	}

	return { hardPairs: hard.length, sampled: sample.length }
}

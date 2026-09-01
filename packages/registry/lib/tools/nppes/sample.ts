/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The NPPES benchmark's input sample: the variation-rich multi-record set per NPI, plus the corpus-wide
 *   address-frequency table built in the same pass. One registry pass serves any number of states — the cross-state
 *   eval samples two at once.
 */

import { isPresent } from "@mailwoman/core/objects"
import type { TermFrequencyTable } from "@mailwoman/match"

import { addressFrequencyKey, streamRows } from "#index"
import { orgTokens, type NPIPrimary } from "#tools/nppes/org-name"
import { addr, MIN_GROUP_SIZE, norm, NPPES_COLUMNS as C } from "#tools/shared"

/**
 * One synthetic input row for the matcher; `npi` is the hidden NPI-level truth, `entityID` the site-level entity-level
 * truth (subpart-collapsed).
 */
export interface MessyRow extends Record<string, string> {
	npi: string
	name: string
	org: string
	address: string
	auth: string
	/**
	 * Whitespace-joined taxonomy-code set (up to 15 slots) — the #625 code-set discriminator.
	 */
	taxonomy: string
	entityID: string
}

/**
 * One state's slice of the sample pass.
 */
export interface NPPESStateSample {
	rows: MessyRow[]
	/**
	 * The sampled NPIs — the true-entity count at the NPI grain.
	 */
	keptNpis: Set<string>
	/**
	 * Per-NPI primary org name + practice address key, the basis for the org-name entity truths.
	 */
	npiPrimary: Map<string, NPIPrimary>
}

/**
 * What the single-state sample pass yields.
 */
export interface NPPESSample extends NPPESStateSample {
	/**
	 * Corpus-wide address-frequency table — the inverse-frequency signal. Counted over EVERY practice address in the
	 * registry, not just the sample, so the sharing structure is a corpus statistic rather than a slice artifact.
	 */
	addressFrequency: TermFrequencyTable
}

/**
 * Where the sample comes from and how much of it to take.
 */
export interface NPPESSampleOptions {
	registryPath: string
	otherNamesPath: string
	/**
	 * Already upper-cased; compared against the practice-location state column.
	 */
	state: string
	maxNpis: number
}

/**
 * The multi-state shape of {@linkcode NPPESSampleOptions} — one registry pass fills every state's bucket.
 */
export interface NPPESMultiSampleOptions {
	registryPath: string
	otherNamesPath: string
	/**
	 * Already upper-cased; compared against the practice-location state column.
	 */
	states: readonly string[]
	maxNpisPerState: number
}

/**
 * Build the benchmark's input records from the real registry, one bucket per requested state.
 *
 * Two passes over two files, and the SECOND one cannot break early: the address-frequency table needs every registry
 * row even after the sample is full, so the per-bucket `keptNpis.size < maxNpisPerState` test gates only the sample
 * branch.
 */
export async function buildNPPESStateSamples(
	options: NPPESMultiSampleOptions,
	report?: (line: string) => void
): Promise<{ byState: Map<string, NPPESStateSample>; addressFrequency: TermFrequencyTable }> {
	const { registryPath, otherNamesPath, states, maxNpisPerState } = options

	// --- Phase A: the variation set — NPIs that carry ≥1 alternate organization name. ---
	report?.("[A] streaming other-names…")
	const altNames = new Map<string, string[]>()

	for await (const r of streamRows(otherNamesPath)) {
		const npi = norm(r[C.npi])
		const alt = norm(r[C.otherOrg])

		if (!npi || !alt) continue
		const list = altNames.get(npi) ?? []

		if (list.length < MIN_GROUP_SIZE) {
			list.push(alt)
		}

		// cap fan-out per NPI
		altNames.set(npi, list)
	}

	report?.(`    ${altNames.size} NPIs with ≥1 alternate name`)

	// --- Phase B: ONE full registry pass — build the GLOBAL address-frequency table (every practice
	// address, so the sharing structure is corpus-wide, not sample-biased) AND collect every state's sample. ---
	report?.(`[B] full registry pass: address-frequency table + ${maxNpisPerState} × ${states.join("/")} sample…`)

	const byState = new Map<string, NPPESStateSample>(
		states.map((state) => [state, { rows: [], keptNpis: new Set<string>(), npiPrimary: new Map<string, NPIPrimary>() }])
	)

	const addrCounts = new Map<string, number>()
	let addrTotal = 0
	let scanned = 0
	let keptTotal = 0

	for await (const r of streamRows(registryPath)) {
		if (++scanned % 1_000_000 === 0) {
			report?.(`    scanned ${scanned / 1e6}M rows, kept ${keptTotal}`)
		}

		const practice = addr(r[C.pAddr]!, r[C.pCity]!, r[C.pState]!, r[C.pZip]!)

		// Global address-frequency: count every practice address (one row ≈ one distinct NPI).
		if (practice) {
			const k = addressFrequencyKey(practice)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)

			addrTotal++
		}

		// Sample: in-state NPIs with ≥1 alternate name, up to maxNpisPerState — NO early break (the table
		// needs the full pass).
		const npi = norm(r[C.npi])
		const bucket = byState.get(norm(r[C.pState]).toUpperCase())

		if (
			bucket &&
			bucket.keptNpis.size < maxNpisPerState &&
			npi &&
			!bucket.keptNpis.has(npi) &&
			altNames.has(npi) &&
			practice
		) {
			const isOrg = norm(r[C.entityType]) === "2"
			const primaryName = isOrg ? norm(r[C.orgLegal]) : `${norm(r[C.first])} ${norm(r[C.last])}`.trim()

			if (primaryName) {
				const org = isOrg ? norm(r[C.orgLegal]) : ""
				const auth = `${norm(r[C.authFirst])} ${norm(r[C.authLast])}`.trim()

				// the NPI's registrant — shared across its records
				// #625: the taxonomy-code set (up to 15 slots), whitespace-joined — identical across the NPI's
				// records by construction (it's a per-NPI registry attribute), so it NEVER splits one entity;
				// it only separates co-located DISTINCT providers whose sets are disjoint.
				const taxonomy = C.taxonomy
					.map((col) => norm(r[col]))
					.filter(isPresent)
					.join(" ")

				// Entity-level (site) truth: same org + same physical address. Subparts (NPPES
				// "Is Organization Subpart" + parent LBN/TIN) collapse to their PARENT, so the matcher isn't
				// charged for correctly fusing one org's many subpart-NPIs at a site; an NPI's mailing-vs-
				// practice records stay DISTINCT sites. orgKey = parent identity for subparts, else the NPI
				// (independent orgs sharing an address stay distinct — the conservative choice).
				const isSubpart = norm(r[C.isSubpart]).toUpperCase() === "Y"
				const parentKey = `${norm(r[C.parentLBN])}|${norm(r[C.parentTIN])}`.toLowerCase()
				const orgKey = isSubpart && parentKey !== "|" ? `p:${parentKey}` : `n:${npi}`
				const eid = (a: string) => `${addressFrequencyKey(a)}|${orgKey}`

				if (org) {
					bucket.npiPrimary.set(npi, { tokens: orgTokens(org), addrKey: addressFrequencyKey(practice) })
				}

				bucket.keptNpis.add(npi)

				keptTotal++
				bucket.rows.push({ npi, name: primaryName, org, address: practice, auth, taxonomy, entityID: eid(practice) })

				// primary
				for (const alt of altNames.get(npi)!) {
					bucket.rows.push({ npi, name: alt, org: alt, address: practice, auth, taxonomy, entityID: eid(practice) })
				}

				// name drift
				const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)

				if (mailing && mailing !== practice) {
					bucket.rows.push({ npi, name: primaryName, org, address: mailing, auth, taxonomy, entityID: eid(mailing) })
				} // address variation
			}
		}
	}

	// Corpus-wide address-frequency table — the inverse-frequency signal (#617 fix per the DeepSeek consult).
	const addressFrequency: TermFrequencyTable = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}

	for (const [state, bucket] of byState) {
		report?.(`    ${state}: ${bucket.keptNpis.size} NPIs → ${bucket.rows.length} records`)
	}

	report?.(`    address table: ${addrCounts.size} distinct over ${addrTotal} rows`)

	return { byState, addressFrequency }
}

/**
 * Build one state's benchmark input records — {@linkcode buildNPPESStateSamples} with a single bucket.
 */
export async function buildNPPESSample(
	options: NPPESSampleOptions,
	report?: (line: string) => void
): Promise<NPPESSample> {
	const { byState, addressFrequency } = await buildNPPESStateSamples(
		{
			registryPath: options.registryPath,
			otherNamesPath: options.otherNamesPath,
			states: [options.state],
			maxNpisPerState: options.maxNpis,
		},
		report
	)

	return { ...byState.get(options.state)!, addressFrequency }
}

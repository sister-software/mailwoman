/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The NPPES benchmark's input sample: the variation-rich multi-record set per NPI, plus the
 *   corpus-wide address-frequency table built in the same pass. One registry pass serves any number
 *   of states, so the cross-state eval samples two at once.
 */

import { isPresent } from "@mailwoman/core/objects"
import type { TermFrequencyTable } from "@mailwoman/match"

import { addressFrequencyKey, streamRows } from "#index"
import { orgTokens, type NPIPrimary } from "#tools/nppes/org-name"
import { addr, MIN_GROUP_SIZE, norm, NPPES_COLUMNS as C } from "#tools/shared"

/**
 * One synthetic input row for the matcher. `npi` is the hidden NPI-level truth, and `entityID` is
 * the site-level entity-level truth (subpart-collapsed).
 */
export interface MessyRow extends Record<string, string> {
	npi: string
	name: string
	org: string
	address: string
	auth: string
	/**
	 * Whitespace-joined taxonomy-code set, up to 15 slots, used as the code-set discriminator.
	 */
	taxonomy: string
	entityID: string
}

/**
 * One state's share of the sample pass.
 */
export interface NPPESStateSample {
	rows: MessyRow[]
	/**
	 * The sampled NPIs, which are the true-entity count at the NPI grain.
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
	 * Corpus-wide address-frequency table, the inverse-frequency signal.
	 *
	 * Counted over every practice address in the registry rather than just the sample, so the sharing
	 * structure is a corpus statistic rather than a sampling artifact.
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
	 * Already upper-cased.
	 * Compared against the practice-location state column.
	 */
	state: string
	maxNpis: number
}

/**
 * The multi-state shape of {@linkcode NPPESSampleOptions}, where one registry pass fills every state's bucket.
 */
export interface NPPESMultiSampleOptions {
	registryPath: string
	otherNamesPath: string
	/**
	 * Already upper-cased.
	 * Compared against the practice-location state column.
	 */
	states: readonly string[]
	maxNpisPerState: number
}

/**
 * Build the benchmark's input records from the real registry, one bucket per requested state.
 *
 * Two passes over two files, and the second cannot break early, because the address-frequency table
 * needs every registry row even after the sample is full. The per-bucket
 * `keptNpis.size < maxNpisPerState` test bounds only the sample branch.
 */
export async function buildNPPESStateSamples(
	options: NPPESMultiSampleOptions,
	report?: (line: string) => void
): Promise<{ byState: Map<string, NPPESStateSample>; addressFrequency: TermFrequencyTable }> {
	const { registryPath, otherNamesPath, states, maxNpisPerState } = options

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

	// One full registry pass builds the global address-frequency table and collects every state's
	// sample. Counting every row keeps the sharing structure corpus-wide rather than sample-biased.
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

		if (practice) {
			const k = addressFrequencyKey(practice)
			addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)

			addrTotal++
		}

		// No early break here, since the table needs the full pass.
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

				// The taxonomy-code set (up to 15 slots) is whitespace-joined and identical across
				// the NPI's records by construction, so it never splits one entity. It only
				// separates co-located distinct providers whose sets are disjoint.
				const taxonomy = C.taxonomy
					.map((col) => norm(r[col]))
					.filter(isPresent)
					.join(" ")

				// Entity-level (site) truth is the same org and the same physical address. Subparts
				// (NPPES "Is Organization Subpart" plus parent LBN/TIN) collapse to their parent, so
				// the matcher is not charged for correctly fusing one org's many subpart-NPIs at a
				// site. An NPI's mailing and practice records stay distinct sites. `orgKey` is the
				// parent identity for a subpart, else the NPI, so independent orgs sharing an address
				// stay distinct.
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

				for (const alt of altNames.get(npi)!) {
					bucket.rows.push({ npi, name: alt, org: alt, address: practice, auth, taxonomy, entityID: eid(practice) })
				}

				const mailing = addr(r[C.mAddr]!, r[C.mCity]!, r[C.mState]!, r[C.mZip]!)

				if (mailing && mailing !== practice) {
					bucket.rows.push({ npi, name: primaryName, org, address: mailing, auth, taxonomy, entityID: eid(mailing) })
				}
			}
		}
	}

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
 * Build one state's benchmark input records, which is {@linkcode buildNPPESStateSamples} with a single bucket.
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

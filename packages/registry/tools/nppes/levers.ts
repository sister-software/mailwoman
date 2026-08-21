/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The comparison-model lever progression the NPPES benchmark walks — each row turns one lever on so its marginal
 *   effect is isolated.
 */

import type { TermFrequencyTable } from "@mailwoman/match"

/**
 * The subset of `ResolveConfig` this progression varies.
 */
export interface LeverConfig {
	addressFrequency?: TermFrequencyTable | false
	collapseSpatial?: boolean
	discriminators?: string[]
	requireCorroboration?: boolean
	usePhone?: boolean
	linkage?: "single" | "average"
	exactDiscriminators?: string[]
}

/**
 * One row of the progression.
 */
export interface Lever {
	label: string
	config: LeverConfig
}

/**
 * Build the progression against a corpus-wide address-frequency table.
 *
 * Every row sets BOTH `collapseSpatial` and `addressFrequency` EXPLICITLY, because the proven levers are default-on in
 * `resolveEntities`: leave either implicit and the flipped default silently rides the `+ inverse-address-frequency`
 * row, making the A1 delta read as 0. Every row is fed the corpus-wide table — the realistic deployment, where the CLI
 * builds it from the full source files — so the zero-config default, whose input-scoped table is intentionally sparse
 * on a sub-sample, has to be measured separately.
 */
export function buildLevers(addressFrequency: TermFrequencyTable): Lever[] {
	return [
		{
			label: "baseline (legacy: address-key + distance, levers OFF)",
			config: { collapseSpatial: false, addressFrequency: false },
		},
		{ label: "+ inverse-address-frequency (#617, corpus-wide)", config: { collapseSpatial: false, addressFrequency } },
		{ label: "+ collapsed spatial signal (A1, #625)", config: { collapseSpatial: true, addressFrequency } },
		{
			label: "+ authorized-official discriminator (#625)",
			config: { collapseSpatial: true, addressFrequency, discriminators: ["authorizedOfficial"] },
		},
		// A2–A4 (#625): the built-but-unmeasured over-merge levers. Each builds on the A1 + discriminator
		// stack so the marginal effect is isolated. A2 (require name/org corroboration) is the direct
		// over-merge precision lever; A3 (phone) is the recall-tail corroborator that should keep A2 from
		// killing name-drift links; A4 (average-linkage) splits a component joined only by a weak bridge.
		{
			label: "+ require name/org corroboration (A2, #625)",
			config: {
				collapseSpatial: true,
				addressFrequency,
				discriminators: ["authorizedOfficial"],
				requireCorroboration: true,
			},
		},
		{
			label: "+ phone comparison (A3, #625)",
			config: {
				collapseSpatial: true,
				addressFrequency,
				discriminators: ["authorizedOfficial"],
				requireCorroboration: true,
				usePhone: true,
			},
		},
		{
			label: "+ average-linkage clustering (A4, #625, full A1–A4 stack)",
			config: {
				collapseSpatial: true,
				addressFrequency,
				discriminators: ["authorizedOfficial"],
				requireCorroboration: true,
				usePhone: true,
				linkage: "average",
			},
		},
		// A5 (#625): the taxonomy code-set discriminator — set-overlap agreement over the NPI's 15 taxonomy
		// slots. The named "still-more-distinctive identifier" from the 2026-06-16 report: co-located
		// DISTINCT providers usually have disjoint sets (the over-merge separator) while an entity's own
		// records always share theirs (never splits). Stacked on the BEST prior classical config (A1 +
		// authorized-official; A3 phone + A4 avg-linkage were measured neutral-to-negative and are left off).
		{
			label: "+ taxonomy code-set discriminator (A5, #625)",
			config: {
				collapseSpatial: true,
				addressFrequency,
				discriminators: ["authorizedOfficial"],
				exactDiscriminators: ["taxonomy"],
			},
		},
	]
}

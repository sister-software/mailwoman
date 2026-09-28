/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The comparison-model setting progression the NPPES benchmark walks, where each row turns one
 *   setting on so its marginal effect is isolated.
 */

import type { TermFrequencyTable } from "@mailwoman/match"

/**
 * The subset of `ResolveConfig` this progression varies.
 */
export interface SettingConfig {
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
export interface Setting {
	label: string
	config: SettingConfig
}

/**
 * Build the progression against a corpus-wide address-frequency table.
 *
 * Every row sets both `collapseSpatial` and `addressFrequency` explicitly, because the proven
 * settings are default-on in `resolveEntities`. Leave either implicit and the flipped default
 * silently rides the inverse-address-frequency row, which makes the delta read as 0.
 *
 * Every row is fed the corpus-wide table, the realistic deployment, so the zero-config default with
 * its input-scoped table has to be measured separately.
 */
export function buildSettings(addressFrequency: TermFrequencyTable): Setting[] {
	return [
		{
			label: "baseline (legacy: address-key + distance, settings OFF)",
			config: { collapseSpatial: false, addressFrequency: false },
		},
		{ label: "+ inverse-address-frequency (#617, corpus-wide)", config: { collapseSpatial: false, addressFrequency } },
		{ label: "+ collapsed spatial signal (A1, #625)", config: { collapseSpatial: true, addressFrequency } },
		{
			label: "+ authorized-official discriminator (#625)",
			config: { collapseSpatial: true, addressFrequency, discriminators: ["authorizedOfficial"] },
		},
		// The over-merge settings each build on the collapsed-spatial and discriminator stack, so the
		// marginal effect of each is isolated.
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
		// The taxonomy code-set discriminator uses set-overlap agreement over the NPI's 15 taxonomy
		// slots. Co-located distinct providers usually have disjoint sets, while an entity's own
		// records always share theirs. It is stacked on the best prior classical config.
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

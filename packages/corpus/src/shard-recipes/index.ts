/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic-corpus SHARD RECIPE registry. Each recipe ({@link ShardRecipe}) is what one legacy
 *   `build-*-shard.mjs` script used to be; the `mailwoman corpus shard <recipe>` command dispatches
 *   to them. A new shard is a new entry here, not a new script.
 */

import { anchorAbsorptionRecipe } from "#shard-recipes/anchor-absorption"
import { bareCountryRecipe } from "#shard-recipes/bare-country"
import { boundaryStressRecipe } from "#shard-recipes/boundary-stress"
import { countryBalancedRecipe } from "#shard-recipes/country-balanced"
import { czPcFirstPrepositionRecipe } from "#shard-recipes/cz-pcfirst-preposition"
import { frAdminSplitRecipe } from "#shard-recipes/fr-admin-split"
import { frBareStreetRecipe } from "#shard-recipes/fr-bare-street"
import { frFragmentRecipe } from "#shard-recipes/fr-fragment"
import { frLieuditRecipe } from "#shard-recipes/fr-lieudit"
import { frOrderRecipe } from "#shard-recipes/fr-order"
import { germanRecipe } from "#shard-recipes/german"
import { houseVenueRecipe } from "#shard-recipes/house-venue"
import { intersectionRecipe } from "#shard-recipes/intersection"
import { localeRecipe } from "#shard-recipes/locale"
import { nlPostcodeRecipe } from "#shard-recipes/nl-postcode"
import { noFragmentRecipe } from "#shard-recipes/no-fragment"
import { noStreetRecipe } from "#shard-recipes/no-street"
import { noStreetLedRecipe } from "#shard-recipes/no-street-led"
import { poBoxRecipe } from "#shard-recipes/po-box"
import { poBoxCedexRecipe } from "#shard-recipes/po-box-cedex"
import { reviewedPostcodeTailRecipe } from "#shard-recipes/reviewed-postcode-tail"
import type { ShardRecipe } from "#shard-recipes/scaffold"
import { siBareVillageRecipe } from "#shard-recipes/si-bare-village"
import { streetRecipe } from "#shard-recipes/street"
import { streetAffixRecipe, suffixBoundaryRecipe } from "#shard-recipes/street-affix"
import { streetBareRecipe } from "#shard-recipes/street-bare"
import { subVenueRecipe } from "#shard-recipes/sub-venue"
import { trailingRegionRecipe } from "#shard-recipes/trailing-region"
import { unitRecipe } from "#shard-recipes/unit"

export * from "#shard-recipes/scaffold"

/**
 * Every registered recipe, in display order.
 */
const RECIPES: readonly ShardRecipe[] = [
	bareCountryRecipe,
	trailingRegionRecipe,
	reviewedPostcodeTailRecipe,
	streetRecipe,
	streetBareRecipe,
	streetAffixRecipe,
	suffixBoundaryRecipe,
	noStreetRecipe,
	houseVenueRecipe,
	poBoxRecipe,
	poBoxCedexRecipe,
	unitRecipe,
	intersectionRecipe,
	germanRecipe,
	localeRecipe,
	frOrderRecipe,
	frAdminSplitRecipe,
	frBareStreetRecipe,
	frFragmentRecipe,
	frLieuditRecipe,
	czPcFirstPrepositionRecipe,
	nlPostcodeRecipe,
	noStreetLedRecipe,
	noFragmentRecipe,
	siBareVillageRecipe,
	countryBalancedRecipe,
	boundaryStressRecipe,
	anchorAbsorptionRecipe,
	subVenueRecipe,
]

/**
 * Recipe name → recipe.
 */
export const SHARD_RECIPES: ReadonlyMap<string, ShardRecipe> = new Map(RECIPES.map((r) => [r.name, r]))

/**
 * Look up a recipe by its `<recipe>` name.
 */
export function getShardRecipe(name: string): ShardRecipe | undefined {
	return SHARD_RECIPES.get(name)
}

/**
 * All recipes (for `--list` / help).
 */
export function listShardRecipes(): readonly ShardRecipe[] {
	return RECIPES
}

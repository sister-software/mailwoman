/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic-corpus SLICE RECIPE registry. Each recipe ({@link CorpusRecipe}) is what one legacy
 *   `build-*-slice.mjs` script used to be; the `mailwoman corpus slice <recipe>` command dispatches
 *   to them. A new slice is a new entry here, not a new script.
 */

import { anchorAbsorptionRecipe } from "#recipes/anchor-absorption"
import { bareCountryRecipe } from "#recipes/bare-country"
import { boundaryStressRecipe } from "#recipes/boundary-stress"
import { countryBalancedRecipe } from "#recipes/country-balanced"
import { czPcFirstPrepositionRecipe } from "#recipes/cz-pcfirst-preposition"
import { frAdminSplitRecipe } from "#recipes/fr-admin-split"
import { frBareStreetRecipe } from "#recipes/fr-bare-street"
import { frFragmentRecipe } from "#recipes/fr-fragment"
import { frLieuditRecipe } from "#recipes/fr-lieudit"
import { frOrderRecipe } from "#recipes/fr-order"
import { germanRecipe } from "#recipes/german"
import { houseVenueRecipe } from "#recipes/house-venue"
import { intersectionRecipe } from "#recipes/intersection"
import { localeRecipe } from "#recipes/locale"
import { nlPostcodeRecipe } from "#recipes/nl-postcode"
import { noFragmentRecipe } from "#recipes/no-fragment"
import { noStreetRecipe } from "#recipes/no-street"
import { noStreetLedRecipe } from "#recipes/no-street-led"
import { poBoxRecipe } from "#recipes/po-box"
import { poBoxCedexRecipe } from "#recipes/po-box-cedex"
import { reviewedPostcodeTailRecipe } from "#recipes/reviewed-postcode-tail"
import type { CorpusRecipe } from "#recipes/scaffold"
import { siBareVillageRecipe } from "#recipes/si-bare-village"
import { streetRecipe } from "#recipes/street"
import { streetAffixRecipe, suffixBoundaryRecipe } from "#recipes/street-affix"
import { streetBareRecipe } from "#recipes/street-bare"
import { subVenueRecipe } from "#recipes/sub-venue"
import { trailingRegionRecipe } from "#recipes/trailing-region"
import { unitRecipe } from "#recipes/unit"

export * from "#recipes/scaffold"

/**
 * Every registered recipe, in display order.
 */
const RECIPES: readonly CorpusRecipe[] = [
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
export const SLICE_RECIPES: ReadonlyMap<string, CorpusRecipe> = new Map(RECIPES.map((r) => [r.name, r]))

/**
 * Look up a recipe by its `<recipe>` name.
 */
export function getSliceRecipe(name: string): CorpusRecipe | undefined {
	return SLICE_RECIPES.get(name)
}

/**
 * All recipes (for `--list` / help).
 */
export function listSliceRecipes(): readonly CorpusRecipe[] {
	return RECIPES
}

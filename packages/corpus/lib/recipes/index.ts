/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic-corpus SLICE RECIPE registry. Each recipe ({@link CorpusRecipe}) is what one legacy
 *   `build-*-slice.mjs` script used to be; the `mailwoman corpus slice <recipe>` command dispatches
 *   to them. A new slice is a new entry here, not a new script.
 */

import { cnOrganizationalUnitsRecipe } from "#cn/recipes/organizational-units"
import { czPcFirstPrepositionRecipe } from "#cz/recipes/pcfirst-preposition"
import { germanRecipe } from "#de/recipes/locale"
import { frAdminSplitRecipe } from "#fr/recipes/admin-split"
import { frBareStreetRecipe } from "#fr/recipes/bare-street"
import { frFragmentRecipe } from "#fr/recipes/fragment"
import { frLieuditRecipe } from "#fr/recipes/lieudit"
import { frOrderRecipe } from "#fr/recipes/order"
import { localeRecipe } from "#international/recipes/locale"
import { nlPostcodeRecipe } from "#nl/recipes/postcode"
import { noFragmentRecipe } from "#no/recipes/fragment"
import { noStreetRecipe } from "#no/recipes/street/index"
import { noStreetLedRecipe } from "#no/recipes/street/led"
import { anchorAbsorptionRecipe } from "#recipes/anchor-absorption"
import { bareCountryRecipe } from "#recipes/bare/country"
import { barePostcodeRecipe } from "#recipes/bare/postcode/index"
import { boundaryStressRecipe } from "#recipes/boundary-stress"
import { countryBalancedRecipe } from "#recipes/country-balanced"
import { houseVenueRecipe } from "#recipes/house-venue"
import { intersectionRecipe } from "#recipes/intersection"
import { poBoxCedexRecipe } from "#recipes/po/box/cedex"
import { poBoxRecipe } from "#recipes/po/box/index"
import type { CorpusRecipe } from "#recipes/scaffold"
import { streetRecipe } from "#recipes/street"
import { streetAffixRecipe, suffixBoundaryRecipe } from "#recipes/street/affix"
import { streetBareRecipe } from "#recipes/street/bare"
import { subVenueRecipe } from "#recipes/sub/venue/index"
import { trailingRegionRecipe } from "#recipes/trailing-region"
import { unitRecipe } from "#recipes/unit"
import { sgRegisterRecipe } from "#sg/recipes/register"
import { siBareVillageRecipe } from "#si/recipes/bare-village"
import { bdRegisterRecipe, pkRegisterRecipe } from "#south-asia/recipes/register"
import { reviewedPostcodeTailRecipe } from "#ve/recipes/reviewed-postcode-tail"

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
	cnOrganizationalUnitsRecipe,
	sgRegisterRecipe,
	pkRegisterRecipe,
	bdRegisterRecipe,
	localeRecipe,
	frOrderRecipe,
	frAdminSplitRecipe,
	frBareStreetRecipe,
	frFragmentRecipe,
	frLieuditRecipe,
	czPcFirstPrepositionRecipe,
	nlPostcodeRecipe,
	barePostcodeRecipe,
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

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic-corpus SHARD RECIPE registry. Each recipe ({@link ShardRecipe}) is what one legacy
 *   `build-*-shard.mjs` script used to be; the `mailwoman corpus shard <recipe>` command dispatches
 *   to them. A new shard is a new entry here, not a new script.
 */

import { anchorAbsorptionRecipe } from "./anchor-absorption.ts"
import { boundaryStressRecipe } from "./boundary-stress.ts"
import { countryBalancedRecipe } from "./country-balanced.ts"
import { czPcFirstPrepositionRecipe } from "./cz-pcfirst-preposition.ts"
import { frAdminSplitRecipe } from "./fr-admin-split.ts"
import { frBareStreetRecipe } from "./fr-bare-street.ts"
import { frOrderRecipe } from "./fr-order.ts"
import { germanRecipe } from "./german.ts"
import { houseVenueRecipe } from "./house-venue.ts"
import { intersectionRecipe } from "./intersection.ts"
import { localeRecipe } from "./locale.ts"
import { nlPostcodeRecipe } from "./nl-postcode.ts"
import { noStreetLedRecipe } from "./no-street-led.ts"
import { noStreetRecipe } from "./no-street.ts"
import { poBoxCedexRecipe } from "./po-box-cedex.ts"
import { poBoxRecipe } from "./po-box.ts"
import type { ShardRecipe } from "./scaffold.ts"
import { siBareVillageRecipe } from "./si-bare-village.ts"
import { streetAffixRecipe } from "./street-affix.ts"
import { streetBareRecipe } from "./street-bare.ts"
import { streetRecipe } from "./street.ts"
import { unitRecipe } from "./unit.ts"

export * from "./scaffold.ts"

/** Every registered recipe, in display order. */
const RECIPES: readonly ShardRecipe[] = [
	streetRecipe,
	streetBareRecipe,
	streetAffixRecipe,
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
	czPcFirstPrepositionRecipe,
	nlPostcodeRecipe,
	noStreetLedRecipe,
	siBareVillageRecipe,
	countryBalancedRecipe,
	boundaryStressRecipe,
	anchorAbsorptionRecipe,
]

/** Recipe name → recipe. */
export const SHARD_RECIPES: ReadonlyMap<string, ShardRecipe> = new Map(RECIPES.map((r) => [r.name, r]))

/** Look up a recipe by its `<recipe>` name. */
export function getShardRecipe(name: string): ShardRecipe | undefined {
	return SHARD_RECIPES.get(name)
}

/** All recipes (for `--list` / help). */
export function listShardRecipes(): readonly ShardRecipe[] {
	return RECIPES
}

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic-corpus SHARD RECIPE registry. Each recipe ({@link ShardRecipe}) is what one legacy
 *   `build-*-shard.mjs` script used to be; the `mailwoman corpus shard <recipe>` command dispatches
 *   to them. A new shard is a new entry here, not a new script.
 */

import { anchorAbsorptionRecipe } from "./anchor-absorption.js"
import { boundaryStressRecipe } from "./boundary-stress.js"
import { countryBalancedRecipe } from "./country-balanced.js"
import { frAdminSplitRecipe } from "./fr-admin-split.js"
import { frBareStreetRecipe } from "./fr-bare-street.js"
import { frOrderRecipe } from "./fr-order.js"
import { germanRecipe } from "./german.js"
import { houseVenueRecipe } from "./house-venue.js"
import { intersectionRecipe } from "./intersection.js"
import { localeRecipe } from "./locale.js"
import { noStreetRecipe } from "./no-street.js"
import { poBoxCedexRecipe } from "./po-box-cedex.js"
import { poBoxRecipe } from "./po-box.js"
import type { ShardRecipe } from "./scaffold.js"
import { streetAffixRecipe } from "./street-affix.js"
import { streetBareRecipe } from "./street-bare.js"
import { streetRecipe } from "./street.js"
import { unitRecipe } from "./unit.js"

export * from "./scaffold.js"

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

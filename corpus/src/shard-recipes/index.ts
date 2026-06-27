/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic-corpus SHARD RECIPE registry. Each recipe ({@link ShardRecipe}) is what one legacy
 *   `build-*-shard.mjs` script used to be; the `mailwoman corpus shard <recipe>` command dispatches
 *   to them. A new shard is a new entry here, not a new script.
 */

import type { ShardRecipe } from "./scaffold.js"

import { poBoxRecipe } from "./po-box.js"
import { streetRecipe } from "./street.js"

export * from "./scaffold.js"

/** Every registered recipe, in display order. */
const RECIPES: readonly ShardRecipe[] = [streetRecipe, poBoxRecipe]

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

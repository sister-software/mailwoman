// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reads `scope.config.json`.
 *
 *   It lists the training config behind each shipped model and each shipping
 *   country that holds no support promise.
 *   The customer-facing claim is the promise list in `@mailwoman/codex/support`.
 *
 *   Release requirements are registered in `packages/mailwoman/tools/eval-harness/release/specs/`.
 *
 *   The `repo-health` `locale-scope` check fails when a shipping country is
 *   neither promised nor listed here.
 */

import type { PathBuilderLike } from "path-ts"

import { readLocalJSONFile } from "#fs/readers"
import { repoRootPathBuilder } from "#paths"

/**
 * The parsed `scope.config.json`.
 *
 * Keys that start with `$` hold comments and are skipped.
 * Each `Record<string, string>` maps a country code to the reason for its entry.
 *
 * The `locale-scope` check validates those reasons, so this reader accepts empty ones.
 */
export interface ScopeConfig {
	/**
	 * Maps each shipping locale's country that holds no support promise to the reason.
	 */
	unpromisedShippingLocales: Record<string, string>
	/**
	 * Maps each weights-family ID to the training config that produced its shipped model.
	 */
	trainingConfigs: Record<string, ShippedTrainingConfig>
}

/**
 * The training config behind one shipped model.
 *
 * The config's `country_weights` block decides which countries the model admits.
 * Coverage reports also read this block.
 */
export interface ShippedTrainingConfig {
	/**
	 * The repo-relative path to a config under `packages/corpus/data/training-configs`.
	 */
	config: string
	/**
	 * The package that ships the `model.onnx` this config produced.
	 */
	graphPackage: string
	/**
	 * The `model-card.json` field that the path was copied from.
	 *
	 * The model cards use different fields for the current version.
	 */
	readFrom: string
}

/**
 * Reads `scope.config.json` from a repository root.
 * The default root is this checkout.
 */
export async function readScopeConfig(repoRoot: PathBuilderLike = repoRootPathBuilder()): Promise<ScopeConfig> {
	return readLocalJSONFile<ScopeConfig>(repoRoot, "scope.config.json")
}

/**
 * Returns the training config for one weights family.
 *
 * @throws When the family has no entry.
 * A fallback to another family's config would report the wrong model's admissions.
 */
export function shippedTrainingConfig(scope: ScopeConfig, family: string): ShippedTrainingConfig {
	const entry = scope.trainingConfigs?.[family]

	if (!entry) {
		const known = Object.keys(scope.trainingConfigs ?? {}).join(", ") || "none"

		throw new Error(
			`\`scope.config.json\` names no training config for weights family "${family}". It names: ${known}. ` +
				"Add the entry rather than reading another family's config."
		)
	}

	return entry
}

/**
 * Returns every family's training config, sorted by family ID.
 *
 * Each config covers one model.
 * The countries admitted across all shipped models are the union over these configs.
 */
export function shippedTrainingConfigs(scope: ScopeConfig): Array<ShippedTrainingConfig & { family: string }> {
	return Object.entries(scope.trainingConfigs ?? {})
		.filter(([family]) => !family.startsWith("$"))
		.map(([family, entry]) => ({ family, ...entry }))
		.toSorted((left, right) => left.family.localeCompare(right.family))
}

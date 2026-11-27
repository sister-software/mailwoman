// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { OutcomeDefinition, OutcomeRegistryRow } from "@mailwoman/core/outcome/spec"

/**
 * The outcome definitions repository, cloned beside the Who's On First placetypes fork.
 *
 * `docs/engineering/reference/outcome-kinds.mdx` is its design.
 */
export const OUTCOMES_REPO = {
	name: "whosonfirst-outcomes",
	owner: "mailwoman",
} as const

/**
 * The repository-relative path of the compiled spec.
 */
export const OUTCOMES_SPEC_FILE = "data/outcomes-spec-latest.json"

/**
 * The definitions as read from a clone, before compilation.
 */
export interface OutcomeDefinitionsInput {
	definitions: OutcomeDefinition[]
	registry: OutcomeRegistryRow[]
	exemptions: Record<string, string>
	/**
	 * Every placetype name in the placetypes repository.
	 */
	placetypes: string[]
	/**
	 * The registry of the compiled spec already in the clone, or `null` for a first compilation.
	 */
	previousRegistry: OutcomeRegistryRow[] | null
}

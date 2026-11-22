// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The action table: each act a build or release performs on a set of address sources,
 *   and the operations a source's decision must permit for it.
 *
 *   The table is the one list of what each action performs.
 *   `evaluateLicense` in `#tree` reads it.
 */

import type { PermissionBasis } from "#decision"
import { soldUnderCommercialTerms, SourceOperation } from "#operations"

/**
 * The acts a build or release performs on a set of address sources.
 */
export const LicenseAction = {
	/**
	 * A source's ingest into a training corpus: the copy, extraction, transformation
	 * and training on its rows.
	 */
	Ingest: "ingest",
	/**
	 * A corpus built from a source's rows, and a model trained on them.
	 */
	Train: "train",
	/**
	 * The release of a model trained on a source's rows.
	 *
	 * An offering sold under Mailwoman's commercial terms also performs `commercial-sublicense`.
	 */
	ReleaseModel: "release-model",
	/**
	 * An address layer built from a source's rows and served.
	 */
	ServeAddressLayer: "serve-address-layer",
	/**
	 * An evaluation set rendered from a source's records.
	 *
	 * The source's reservation for evaluation, rather than its decision,
	 * keeps the rows out of every training corpus.
	 */
	EvaluateOnly: "evaluate-only",
} as const

/**
 * One of the {@link LicenseAction} values.
 */
export type LicenseAction = (typeof LicenseAction)[keyof typeof LicenseAction]

/**
 * What one action performs on each source.
 */
export interface ActionRule {
	/**
	 * The operations the action performs on every source, in the order the tree reads them.
	 */
	requires: readonly SourceOperation[]
	/**
	 * The operations the action performs only when its offering sells the result
	 * under Mailwoman's commercial terms.
	 */
	requiresWhenSold?: readonly SourceOperation[]
	/**
	 * The basis every required permission must rest on, for an action that admits one basis only.
	 */
	basisFloor?: PermissionBasis
}

/**
 * Every action and what it performs.
 */
export const LICENSE_ACTIONS: Readonly<Record<LicenseAction, ActionRule>> = {
	[LicenseAction.Ingest]: {
		requires: [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.Transform, SourceOperation.Train],
	},
	[LicenseAction.Train]: {
		// Both need adaptation: normalizing an address into labeled components is a
		// derived work, and fitting a model on it is another.
		requires: [SourceOperation.Transform, SourceOperation.Train],
	},
	[LicenseAction.ReleaseModel]: {
		requires: [SourceOperation.RedistributeModel],
		requiresWhenSold: [SourceOperation.CommercialSublicense],
	},
	[LicenseAction.ServeAddressLayer]: {
		// The layer copies the publisher's file, reads its address fields and redistributes the rows as a database.
		requires: [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.RedistributeData],
	},
	[LicenseAction.EvaluateOnly]: {
		// A reservation for evaluation (`#reservation`) keeps the rows out of every training corpus.
		requires: [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.Transform],
	},
}

/**
 * The operations an action performs on each source for one offering, in table order.
 *
 * `offering` is the license expression the action's result is offered under,
 * or `null` when the action offers no artifact.
 */
export function actionOperations(action: LicenseAction, offering: string | null): SourceOperation[] {
	const rule = LICENSE_ACTIONS[action]
	const sold = offering != null && soldUnderCommercialTerms(offering)

	return [...rule.requires, ...(sold ? (rule.requiresWhenSold ?? []) : [])]
}

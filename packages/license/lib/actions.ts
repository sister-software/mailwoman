// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The action table: each act a build or release performs on a set of address sources,
 *   the operations a source's decision must permit for it, and the purposes it performs them for.
 *
 *   The table is the one list of what each action performs.
 *   `evaluateLicense` in `#tree` reads it.
 */

import { type PermissionBasis, UsePurpose } from "#decision"
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
	 */
	ReleaseModel: "release-model",
	/**
	 * An address layer built from a source's rows and served as downloadable databases.
	 */
	ServeAddressLayer: "serve-address-layer",
	/**
	 * An evaluation set rendered from a source's records, and a model scored on it.
	 *
	 * The source's reservation for evaluation keeps the rows out of every training corpus.
	 */
	Evaluate: "evaluate",
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
	 * Whether the action hands its result to a recipient, so an offering sold under
	 * Mailwoman's commercial terms makes it a `sale`.
	 */
	delivers?: true
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
		requires: [SourceOperation.DistributeModel],
		delivers: true,
	},
	[LicenseAction.ServeAddressLayer]: {
		// The layer copies the publisher's file, reads its address fields and publishes the rows as databases.
		requires: [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.DistributeRows],
		delivers: true,
	},
	[LicenseAction.Evaluate]: {
		// A reservation for evaluation (`#reservation`) keeps the rows out of every training corpus.
		requires: [SourceOperation.Fetch, SourceOperation.Extract, SourceOperation.Transform, SourceOperation.Evaluate],
	},
}

/**
 * The operations an action performs on each source, in table order.
 */
export function actionOperations(action: LicenseAction): SourceOperation[] {
	return [...LICENSE_ACTIONS[action].requires]
}

/**
 * The purposes an action performs its operations for, given the license expression
 * its result is offered under, or `null` when it offers no artifact.
 *
 * Every action is at least `commercial-use`, because the work serves a product sold under
 * `LicenseRef-Commercial`: evaluating a commercially sold model is commercial use.
 * An action that delivers its result under an offering sold under those terms adds `sale`.
 *
 * Ingest, training and evaluation hand no recipient their result, so no offering makes them a sale.
 */
export function actionPurposes(action: LicenseAction, offering: string | null): UsePurpose[] {
	const sold = LICENSE_ACTIONS[action].delivers === true && offering != null && soldUnderCommercialTerms(offering)

	return sold ? [UsePurpose.CommercialUse, UsePurpose.Sale] : [UsePurpose.CommercialUse]
}

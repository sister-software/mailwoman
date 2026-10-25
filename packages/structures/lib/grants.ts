// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { OperationPermission, PermissionBasis, type OperationDecision } from "@mailwoman/core/license/decision"

import { StructureOperation } from "#types"

/**
 * The operation decisions of a publisher grant that permits every {@link StructureOperation},
 * each citing the clause of the retrieved terms that permits it.
 */
export function permittedByGrant(
	because: Readonly<Record<StructureOperation, string>>
): Record<StructureOperation, OperationDecision> {
	const operations = {} as Record<StructureOperation, OperationDecision>

	for (const operation of Object.values(StructureOperation)) {
		operations[operation] = {
			permission: OperationPermission.Permitted,
			basis: PermissionBasis.PublisherGrant,
			because: because[operation],
		}
	}

	return operations
}

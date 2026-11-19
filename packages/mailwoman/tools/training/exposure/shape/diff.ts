// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Compares two train-shape counts per source and country, and reports each tag order whose share moved.
 *
 *   The counts are {@linkcode countTrainShapes}'s.
 *   Two views are compared: the whole span-tag sequence, and its admin tail, the tags of
 *   `ADMIN_HIERARCHY_TAGS` in print order (`locality region postcode`).
 *   A re-render that collapses a country to one order moves the share of every order it dropped.
 */

import { ADMIN_HIERARCHY_TAGS, type ComponentTag } from "@mailwoman/codex/component"
import { stringifyJSON } from "@mailwoman/core/json"

import type { TrainShapeCount } from "../train-shapes.ts"

/**
 * Which tags a distribution keys on.
 */
export const ShapeView = {
	Sequence: "sequence",
	AdminTail: "admin-tail",
} as const

export type ShapeView = (typeof ShapeView)[keyof typeof ShapeView]

const ADMIN_TAGS: ReadonlySet<string> = new Set<ComponentTag>(ADMIN_HIERARCHY_TAGS)

/**
 * Rows per order, for one source and country.
 */
export type OrderCounts = Map<string, number>

/**
 * One source and country's order counts.
 */
export interface SourceCountryOrders {
	source: string
	country: string
	orders: OrderCounts
}

/**
 * Order counts keyed by source and country.
 */
export type ShapeDistribution = Map<string, SourceCountryOrders>

/**
 * Folds train-shape counts into per-source, per-country order counts under `view`.
 *
 * A row with no span tags, or with no admin tag under the admin-tail view, counts under `(none)`.
 */
export function shapeDistribution(counts: Iterable<TrainShapeCount>, view: ShapeView): ShapeDistribution {
	const distribution: ShapeDistribution = new Map()

	for (const count of counts) {
		const tags = view === ShapeView.AdminTail ? count.spanTags?.filter((tag) => ADMIN_TAGS.has(tag)) : count.spanTags
		const order = tags?.length ? tags.join(" ") : "(none)"
		const source = count.source ?? "(none)"
		const country = count.country ?? "(none)"
		const key = stringifyJSON([source, country])
		const entry = distribution.get(key) ?? { source, country, orders: new Map<string, number>() }

		entry.orders.set(order, (entry.orders.get(order) ?? 0) + count.rows)
		distribution.set(key, entry)
	}

	return distribution
}

/**
 * One order's rows and share on each side.
 */
export interface OrderMovement {
	order: string
	before: number
	after: number
	beforeShare: number
	afterShare: number
}

/**
 * One source and country whose orders differ between the two sides.
 */
export interface ShapeDifference {
	source: string
	country: string
	view: ShapeView
	beforeRows: number
	afterRows: number
	/**
	 * Every order on either side, largest share first.
	 */
	orders: OrderMovement[]
	/**
	 * Whether some order's share moved by more than the tolerance.
	 */
	moved: boolean
}

function shares(orders: OrderCounts | undefined): { rows: number; share: (order: string) => number } {
	const rows = [...(orders?.values() ?? [])].reduce((sum, n) => sum + n, 0)

	return { rows, share: (order) => (rows ? (orders?.get(order) ?? 0) / rows : 0) }
}

/**
 * Lists every source and country whose order counts differ.
 *
 * It marks the ones where an order's share moved by more than `tolerance`,
 * a fraction of the country's rows.
 * A source and country present on one side only has every order move from or to a zero share.
 */
export function compareShapeDistributions(
	before: ShapeDistribution,
	after: ShapeDistribution,
	view: ShapeView,
	tolerance: number
): ShapeDifference[] {
	const differences: ShapeDifference[] = []

	for (const key of [...new Set([...before.keys(), ...after.keys()])].toSorted()) {
		const { source, country } = (before.get(key) ?? after.get(key))!
		const a = before.get(key)?.orders
		const b = after.get(key)?.orders
		const sa = shares(a)
		const sb = shares(b)

		const orders = [...new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])])]
			.map((order) => ({
				order,
				before: a?.get(order) ?? 0,
				after: b?.get(order) ?? 0,
				beforeShare: sa.share(order),
				afterShare: sb.share(order),
			}))
			.toSorted((x, y) => Math.max(y.beforeShare, y.afterShare) - Math.max(x.beforeShare, x.afterShare))

		if (orders.every((order) => order.before === order.after)) continue

		differences.push({
			source,
			country,
			view,
			beforeRows: sa.rows,
			afterRows: sb.rows,
			orders,
			moved: orders.some((order) => Math.abs(order.afterShare - order.beforeShare) > tolerance),
		})
	}

	return differences
}

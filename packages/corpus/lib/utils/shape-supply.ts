/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The country–shape supply pass behind the retention table (HOLDOUT_AND_EVALUATION
 * section 5.1): count every combination's distinct groups per split under the current
 * policy, and register the combinations whose training remainder falls below the floor.
 */

import {
	type CountryHoldout,
	defaultHoldouts,
	hashedHoldoutTrainedPlaces,
	type SplitName,
	splitForRow,
} from "#utils/split"
import {
	groupIDOf,
	SHAPE_SEPARATOR,
	type ShapeSupplyEntry,
	type ShapeSupplyRow,
	type SplitRetention,
} from "#utils/split-retention"

/**
 * Count every country–shape combination's distinct groups per split under the
 * given policy, without applying any retention.
 *
 * A group counts in the split the policy would give its row.
 * A group whose variants would straddle two splits counts in each, and the
 * record-ancestry audit of section 4.4 reports those separately.
 */
export function computeShapeSupply(
	rows: Iterable<ShapeSupplyRow>,
	opts: { holdouts?: Record<string, CountryHoldout>; trainedPlaces?: Record<string, readonly string[]> } = {}
): ShapeSupplyEntry[] {
	const holdouts = opts.holdouts ?? defaultHoldouts()
	const trainedPlaces = opts.trainedPlaces ?? hashedHoldoutTrainedPlaces()
	const groups = new Map<string, { country: string; shape: string; splits: Map<string, Set<string>> }>()

	for (const row of rows) {
		if (!row.span_tags.length) continue

		const country = row.country
		const shape = row.span_tags.join(SHAPE_SEPARATOR)
		const key = `${country}|${shape}`
		const split = splitForRow(row, holdouts, trainedPlaces)

		let entry = groups.get(key)

		if (!entry) {
			entry = { country, shape, splits: new Map() }
			groups.set(key, entry)
		}

		let set = entry.splits.get(split)

		if (!set) {
			set = new Set()
			entry.splits.set(split, set)
		}

		set.add(groupIDOf(row))
	}

	return [...groups.values()]
		.map(({ country, shape, splits }) => {
			const perSplit = (name: SplitName) => splits.get(name)?.size ?? 0

			return {
				country,
				shape,
				groups: new Set([...splits.values()].flatMap((set) => [...set])).size,
				trainGroups: perSplit("train"),
				valGroups: perSplit("val"),
				testGroups: perSplit("test"),
			}
		})
		.toSorted((a, b) => (a.country === b.country ? a.shape.localeCompare(b.shape) : a.country.localeCompare(b.country)))
}

/**
 * Register the combinations whose post-holdout training remainder falls below `floor`
 * (section 5.1's retention rule: every group of the combination stays in training,
 * and its held-out accuracy reports as unmeasured until independent evaluation data exists).
 */
export function splitRetentionFromSupply(supply: Iterable<ShapeSupplyEntry>, floor: number): SplitRetention {
	if (!(Number.isInteger(floor) && floor >= 1)) {
		throw new Error(`retention floor takes a positive integer; received ${floor}`)
	}

	const protectedShapes = new Set<string>()

	for (const entry of supply) {
		if (entry.trainGroups < floor) {
			protectedShapes.add(`${entry.country}|${entry.shape}`)
		}
	}

	return { floor, protectedShapes }
}

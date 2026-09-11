/**
 * @copyright Sister Software
 */

import { makeCedex, makePoBoxPhrase } from "#recipes/po/box/cedex/phrases"
import type { FRTuple, Rendered } from "#recipes/po/box/cedex/types"
import { FR_LEADERS, VENUES_FR } from "#recipes/po/box/cedex/vocabulary"
import { pick } from "#synthesizers/utils"

const BP_TAIL_CUTOFF = 0.45,
	BP_BARE_CUTOFF = 0.6,
	BP_CEDEX_CUTOFF = 0.8

const CEDEX_UPPER_LOCALITY_SHARE = 0.6,
	CEDEX_LINE_CUTOFF = 0.4,
	CEDEX_FULL_CUTOFF = 0.75,
	CEDEX_GOLDEN_ORDER_CUTOFF = 0.85

export function renderBpFr(random: () => number, tuple: FRTuple): Rendered {
	const phrase = makePoBoxPhrase(random, FR_LEADERS)
	const { locality, postcode } = tuple
	const location = random() < 0.5 ? locality.toUpperCase() : locality
	const draw = random()

	if (draw < BP_TAIL_CUTOFF)
		return {
			fmt: "bp-tail",
			raw: `${phrase}, ${postcode} ${location}`,
			components: { po_box: phrase, postcode, locality: location },
		}

	if (draw < BP_BARE_CUTOFF) return { fmt: "bp-bare", raw: phrase, components: { po_box: phrase } }

	if (draw < BP_CEDEX_CUTOFF) {
		const cedex = makeCedex(random)
		const upperLocality = locality.toUpperCase()

		return {
			fmt: "bp-cedex",
			raw: `${phrase}, ${postcode} ${upperLocality} ${cedex}`,
			components: { po_box: phrase, postcode, locality: upperLocality, cedex },
		}
	}

	const venue = pick(VENUES_FR, random)

	return {
		fmt: "bp-venue",
		raw: `${venue}, ${phrase}, ${postcode} ${location}`,
		components: { venue, po_box: phrase, postcode, locality: location },
	}
}

export function renderCedexFr(random: () => number, tuple: FRTuple): Rendered {
	const cedex = makeCedex(random)
	const { house_number, street, locality, postcode } = tuple
	const location = random() < CEDEX_UPPER_LOCALITY_SHARE ? locality.toUpperCase() : locality
	const line = { postcode, locality: location, cedex }
	const draw = random()

	if (draw < CEDEX_LINE_CUTOFF) return { fmt: "cedex-line", raw: `${postcode} ${location} ${cedex}`, components: line }

	if (draw < CEDEX_FULL_CUTOFF)
		return {
			fmt: "cedex-full",
			raw: `${house_number} ${street}, ${postcode} ${location} ${cedex}`,
			components: { house_number, street, ...line },
		}

	if (draw < CEDEX_GOLDEN_ORDER_CUTOFF)
		return { fmt: "cedex-golden-order", raw: `${postcode} ${cedex} ${location}`, components: line }

	const venue = pick(VENUES_FR, random)

	return { fmt: "cedex-venue", raw: `${venue}, ${postcode} ${location} ${cedex}`, components: { venue, ...line } }
}

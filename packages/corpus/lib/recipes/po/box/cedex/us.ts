/**
 * @copyright Sister Software
 */

import { makePoBoxPhrase } from "#recipes/po/box/cedex/phrases"
import type { Rendered, USTuple } from "#recipes/po/box/cedex/types"
import { US_LEADERS_COMMON, US_LEADERS_RARE, US_PMB_LEADERS, VENUES_EN } from "#recipes/po/box/cedex/vocabulary"
import { pick } from "#synthesizers/utils"

const US_FULL_CUTOFF = 0.4,
	US_NO_POSTCODE_CUTOFF = 0.55,
	US_BARE_CUTOFF = 0.75,
	US_VENUE_CUTOFF = 0.9

const PMB_AFTER_STREET_CUTOFF = 0.5,
	PMB_COMMA_CUTOFF = 0.85

export function renderPoBoxUs(random: () => number, tuple: USTuple): Rendered {
	const phrase = makePoBoxPhrase(random, US_LEADERS_COMMON, US_LEADERS_RARE)
	const { locality, region, postcode } = tuple
	const base = { po_box: phrase, locality, region }
	const draw = random()

	if (draw < US_FULL_CUTOFF && postcode)
		return { fmt: "full", raw: `${phrase}, ${locality}, ${region} ${postcode}`, components: { ...base, postcode } }

	if (draw < US_NO_POSTCODE_CUTOFF)
		return { fmt: "no-postcode", raw: `${phrase}, ${locality}, ${region}`, components: base }

	if (draw < US_BARE_CUTOFF) return { fmt: "bare", raw: phrase, components: { po_box: phrase } }

	if (draw < US_VENUE_CUTOFF) {
		const venue = pick(VENUES_EN, random)

		return {
			fmt: "venue",
			raw: postcode
				? `${venue}, ${phrase}, ${locality}, ${region} ${postcode}`
				: `${venue}, ${phrase}, ${locality}, ${region}`,
			components: { venue, ...base, ...(postcode ? { postcode } : {}) },
		}
	}

	const upper = (value: string) => value.toUpperCase()

	return {
		fmt: "label-nocomma",
		raw: postcode
			? `${upper(phrase)} ${upper(locality)} ${region} ${postcode}`
			: `${upper(phrase)} ${upper(locality)} ${region}`,
		components: { po_box: upper(phrase), locality: upper(locality), region, ...(postcode ? { postcode } : {}) },
	}
}

export function renderPmbUs(random: () => number, tuple: USTuple): Rendered {
	const phrase = makePoBoxPhrase(random, US_PMB_LEADERS)
	const { house_number, street, locality, region, postcode } = tuple
	const road = `${house_number} ${street}`
	const components = { house_number, street, po_box: phrase, locality, region, postcode }
	const draw = random()

	if (draw < PMB_AFTER_STREET_CUTOFF)
		return { fmt: "pmb-after-street", raw: `${road} ${phrase}, ${locality}, ${region} ${postcode}`, components }

	if (draw < PMB_COMMA_CUTOFF)
		return { fmt: "pmb-comma", raw: `${road}, ${phrase}, ${locality}, ${region} ${postcode}`, components }

	return { fmt: "pmb-bare", raw: `${road} ${phrase}`, components: { house_number, street, po_box: phrase } }
}

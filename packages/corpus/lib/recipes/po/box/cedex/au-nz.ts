/**
 * @copyright Sister Software
 */

import { isAuDeliveryService } from "@mailwoman/codex/au"
import { isNZDeliveryService } from "@mailwoman/codex/nz"

import { makeAuNZPoBoxPhrase } from "#recipes/po/box/cedex/phrases"
import type { AUTuple, NZTuple, Rendered } from "#recipes/po/box/cedex/types"
import {
	AU_LEADERS_CURRENT,
	AU_LEADERS_LEGACY,
	NZ_LEADERS_COMMON,
	NZ_LEADERS_RARE,
	VENUES_EN,
} from "#recipes/po/box/cedex/vocabulary"
import { pick } from "#synthesizers/utils"

const AU_UPPER_LOCALITY_CUTOFF = 0.6,
	AU_STANDARD_CUTOFF = 0.45,
	AU_LABEL_CUTOFF = 0.6,
	AU_NO_POSTCODE_CUTOFF = 0.75,
	AU_BARE_CUTOFF = 0.88

const NZ_STANDARD_CUTOFF = 0.55,
	NZ_NO_POSTCODE_CUTOFF = 0.7,
	NZ_BARE_CUTOFF = 0.85

export function renderAUPoBox(random: () => number, tuple: AUTuple): Rendered {
	const phrase = makeAuNZPoBoxPhrase(random, AU_LEADERS_CURRENT, AU_LEADERS_LEGACY, isAuDeliveryService)
	const { locality, region, postcode } = tuple
	const draw = random()
	const location = draw < AU_UPPER_LOCALITY_CUTOFF ? locality.toUpperCase() : locality
	const base = { po_box: phrase, locality: location, region, postcode }

	if (draw < AU_STANDARD_CUTOFF)
		return { fmt: "au-standard", raw: `${phrase}, ${location} ${region} ${postcode}`, components: base }

	if (draw < AU_LABEL_CUTOFF) {
		const upper = phrase.toUpperCase()

		return {
			fmt: "au-label-nocomma",
			raw: `${upper} ${locality.toUpperCase()} ${region} ${postcode}`,
			components: { po_box: upper, locality: locality.toUpperCase(), region, postcode },
		}
	}

	if (draw < AU_NO_POSTCODE_CUTOFF)
		return {
			fmt: "au-no-postcode",
			raw: `${phrase}, ${location} ${region}`,
			components: { po_box: phrase, locality: location, region },
		}

	if (draw < AU_BARE_CUTOFF) return { fmt: "au-bare", raw: phrase, components: { po_box: phrase } }
	const venue = pick(VENUES_EN, random)

	return {
		fmt: "au-venue",
		raw: `${venue}, ${phrase}, ${location} ${region} ${postcode}`,
		components: { venue, ...base },
	}
}

export function renderNZPoBox(random: () => number, tuple: NZTuple): Rendered {
	const phrase = makeAuNZPoBoxPhrase(random, NZ_LEADERS_COMMON, NZ_LEADERS_RARE, isNZDeliveryService)
	const { locality, postcode } = tuple
	const base = { po_box: phrase, locality, postcode }
	const draw = random()

	if (draw < NZ_STANDARD_CUTOFF)
		return { fmt: "nz-standard", raw: `${phrase}, ${locality} ${postcode}`, components: base }

	if (draw < NZ_NO_POSTCODE_CUTOFF)
		return { fmt: "nz-no-postcode", raw: `${phrase}, ${locality}`, components: { po_box: phrase, locality } }

	if (draw < NZ_BARE_CUTOFF) return { fmt: "nz-bare", raw: phrase, components: { po_box: phrase } }
	const venue = pick(VENUES_EN, random)

	return { fmt: "nz-venue", raw: `${venue}, ${phrase}, ${locality} ${postcode}`, components: { venue, ...base } }
}

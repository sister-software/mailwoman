/**
 * @copyright Sister Software
 */

import { makeCaPostcode, makePoBoxPhrase } from "#recipes/po/box/cedex/phrases"
import type { Rendered } from "#recipes/po/box/cedex/types"
import {
	CA_EN_LEADERS,
	CA_FR_LEADERS,
	ON_FSA_LETTERS,
	QC_FSA_LETTERS,
	VENUES_FR,
} from "#recipes/po/box/cedex/vocabulary"
import { pick } from "#synthesizers/utils"

const CA_FR_GOLDEN_ORDER_CUTOFF = 0.4,
	CA_FR_NATIVE_CUTOFF = 0.7,
	CA_FR_BARE_CUTOFF = 0.85

const CA_EN_STANDARD_CUTOFF = 0.5,
	CA_EN_GOLDEN_ORDER_CUTOFF = 0.8

export function renderCaFr(random: () => number, locality: string): Rendered {
	const phrase = makePoBoxPhrase(random, CA_FR_LEADERS)
	const postcode = makeCaPostcode(random, QC_FSA_LETTERS)
	const components = { po_box: phrase, postcode, locality, region: "QC" }
	const draw = random()

	if (draw < CA_FR_GOLDEN_ORDER_CUTOFF)
		return { fmt: "ca-fr-golden-order", raw: `${phrase}, ${postcode} ${locality}, QC`, components }

	if (draw < CA_FR_NATIVE_CUTOFF)
		return { fmt: "ca-fr-native", raw: `${phrase}, ${locality} QC ${postcode}`, components }

	if (draw < CA_FR_BARE_CUTOFF) return { fmt: "ca-fr-bare", raw: phrase, components: { po_box: phrase } }
	const venue = pick(VENUES_FR, random)

	return {
		fmt: "ca-fr-venue",
		raw: `${venue}, ${phrase}, ${locality} QC ${postcode}`,
		components: { venue, ...components },
	}
}

export function renderCaEn(random: () => number, locality: string): Rendered {
	const phrase = makePoBoxPhrase(random, CA_EN_LEADERS)
	const postcode = makeCaPostcode(random, ON_FSA_LETTERS)
	const components = { po_box: phrase, locality, region: "ON", postcode }
	const draw = random()

	if (draw < CA_EN_STANDARD_CUTOFF)
		return { fmt: "ca-en-standard", raw: `${phrase}, ${locality}, ON ${postcode}`, components }

	if (draw < CA_EN_GOLDEN_ORDER_CUTOFF)
		return { fmt: "ca-en-golden-order", raw: `${phrase}, ${postcode} ${locality}, ON`, components }

	return { fmt: "ca-en-bare", raw: phrase, components: { po_box: phrase } }
}

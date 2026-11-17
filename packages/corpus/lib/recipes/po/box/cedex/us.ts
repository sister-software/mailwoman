// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/* oxlint-disable mailwoman/prefer-home -- this module is the US arm of the cedex recipe, identified by its path. Its
 sibling arms cover the other countries. A layout call would answer the same string for the only country that reaches
   it. */

import { matchLeadingDirectional, matchTrailingSuffix } from "@mailwoman/codex/us"
import { sample } from "@mailwoman/core/random"

import { makePoBoxPhrase } from "#recipes/po/box/cedex/phrases"
import type { Rendered, USTuple } from "#recipes/po/box/cedex/types"
import { US_LEADERS_COMMON, US_LEADERS_RARE, US_PMB_LEADERS, VENUES_EN } from "#recipes/po/box/cedex/vocabulary"

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
		const venue = sample(VENUES_EN, random)

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

const LEADING_WORD = /^(\S+)\s+/u,
	TRAILING_WORD = /\s+(\S+)$/u,
	TRAILING_SUFFIX_AND_DIRECTIONAL = /\s+((\S+)\s+(\S+))$/u

/**
 * Splits a US skeleton's street into the schema's `street_prefix`, `street`
 * and `street_suffix`, keeping each span's text as the skeleton writes it.
 *
 * The suffix is the terminal Pub-28 word (`matchTrailingSuffix`), with a post-directional
 * after it joining the suffix as the schema states (`AVENUE NW`).
 * The prefix is a leading directional (`matchLeadingDirectional`).
 *
 * Each is split off only when a street name is left beside it, so `N ST` keeps
 * `N` as its name and a one-word street stays whole.
 */
export function splitUSStreet(street: string): Record<string, string> {
	let name = street.trim()
	const parts: Record<string, string> = {}
	const pair = TRAILING_SUFFIX_AND_DIRECTIONAL.exec(name)
	const trailing = TRAILING_WORD.exec(name)

	if (pair && matchTrailingSuffix(pair[2]!) && matchLeadingDirectional(pair[3]!)) {
		parts.street_suffix = pair[1]!
		name = name.slice(0, pair.index)
	} else if (trailing && matchTrailingSuffix(trailing[1]!)) {
		parts.street_suffix = trailing[1]!
		name = name.slice(0, trailing.index)
	}

	const leading = LEADING_WORD.exec(name)

	if (leading && matchLeadingDirectional(leading[1]!)) {
		parts.street_prefix = leading[1]!
		name = name.slice(leading[0].length)
	}

	return { ...parts, street: name }
}

export function renderPmbUs(random: () => number, tuple: USTuple): Rendered {
	const phrase = makePoBoxPhrase(random, US_PMB_LEADERS)
	const { house_number, street, locality, region, postcode } = tuple
	const road = `${house_number} ${street}`
	const streetParts = splitUSStreet(street)
	const components = { house_number, ...streetParts, po_box: phrase, locality, region, postcode }
	const draw = random()

	if (draw < PMB_AFTER_STREET_CUTOFF)
		return { fmt: "pmb-after-street", raw: `${road} ${phrase}, ${locality}, ${region} ${postcode}`, components }

	if (draw < PMB_COMMA_CUTOFF)
		return { fmt: "pmb-comma", raw: `${road}, ${phrase}, ${locality}, ${region} ${postcode}`, components }

	return { fmt: "pmb-bare", raw: `${road} ${phrase}`, components: { house_number, ...streetParts, po_box: phrase } }
}

/**
 * @copyright Sister Software
 */

import { normalizeCaPostalCode } from "@mailwoman/codex/ca"
import { isCedex } from "@mailwoman/codex/fr"
import { isNZDeliveryService } from "@mailwoman/codex/nz"
import { isUSPoBoxDesignator, matchPOBox } from "@mailwoman/codex/us"

import { CA_INTERIOR_LETTERS } from "#recipes/po/box/cedex/vocabulary"
import { maybeNoisifyBoxNumber } from "#synthesizers/po-box"
import { pick, tieredNumber } from "#synthesizers/utils"

const BOX_TWO_DIGIT_CUTOFF = 0.3
const BOX_THREE_DIGIT_CUTOFF = 0.7
const BOX_FOUR_DIGIT_CUTOFF = 0.95
const TEMPLATE_CASE_CUTOFF = 0.7
const UPPER_CASE_CUTOFF = 0.92
const RARE_LEADER_SHARE = 0.1
const CEDEX_UPPER_CUTOFF = 0.6
const CEDEX_TITLE_CUTOFF = 0.9
const CEDEX_UNNUMBERED_SHARE = 0.2

const pickBoxNumber = (random: () => number): string =>
	tieredNumber(random, [
		{ cutoff: BOX_TWO_DIGIT_CUTOFF, base: 1, span: 99 },
		{ cutoff: BOX_THREE_DIGIT_CUTOFF, base: 100, span: 900 },
		{ cutoff: BOX_FOUR_DIGIT_CUTOFF, base: 1000, span: 9000 },
		{ base: 10_000, span: 90_000 },
	])

const caseDial = (random: () => number, value: string): string => {
	const draw = random()

	return draw < TEMPLATE_CASE_CUTOFF ? value : draw < UPPER_CASE_CUTOFF ? value.toUpperCase() : value.toLowerCase()
}

export function makePoBoxPhrase(
	random: () => number,
	leaders: ReadonlyArray<string>,
	rareLeaders?: ReadonlyArray<string>
): string {
	let leader = pick(leaders, random)

	if (rareLeaders && random() < RARE_LEADER_SHARE) {
		leader = pick(rareLeaders, random)
	}

	const number = maybeNoisifyBoxNumber(pickBoxNumber(random), random)
	const phrase = leader === "#" ? `#${number}` : `${caseDial(random, leader)} ${number}`

	if (isUSPoBoxDesignator(leader) && /^[\dA-Za-z][\dA-Za-z-]*$/.test(number) && !matchPOBox(phrase))
		throw new Error(`generated a po_box phrase the codex matcher rejects: "${phrase}"`)

	return phrase
}

export function makeCedex(random: () => number): string {
	const draw = random()
	const word = draw < CEDEX_UPPER_CUTOFF ? "CEDEX" : draw < CEDEX_TITLE_CUTOFF ? "Cedex" : "cedex"
	let phrase = word

	if (random() >= CEDEX_UNNUMBERED_SHARE) {
		const number = 1 + Math.floor(random() * 20)
		phrase = `${word} ${random() < 0.5 ? String(number).padStart(2, "0") : String(number)}`
	}

	if (!isCedex(phrase)) throw new Error(`makeCedex emitted a phrase the codex matcher rejects: "${phrase}"`)

	return phrase
}

export function makeAuNZPoBoxPhrase(
	random: () => number,
	leaders: ReadonlyArray<string>,
	rareLeaders: ReadonlyArray<string>,
	validate: (input: unknown) => boolean
): string {
	let leader = pick(leaders, random)

	if (random() < RARE_LEADER_SHARE) {
		leader = pick(rareLeaders, random)
	}

	let number = maybeNoisifyBoxNumber(pickBoxNumber(random), random)

	if (leader === "CMB" && validate === isNZDeliveryService) {
		number = `B${number}`
	}

	const phrase = `${caseDial(random, leader)} ${number}`
	const cleanID = validate === isNZDeliveryService ? /^[\dA-Za-z]+$/ : /^[\dA-Za-z][\dA-Za-z-]*$/

	if (cleanID.test(number) && !validate(phrase))
		throw new Error(`generated a phrase the codex matcher rejects: "${phrase}"`)

	return phrase
}

export function makeCaPostcode(random: () => number, fsaLetters: string[]): string {
	const letter = () => CA_INTERIOR_LETTERS[Math.floor(random() * CA_INTERIOR_LETTERS.length)]!
	const digit = () => String(Math.floor(random() * 10))
	const postcode = `${pick(fsaLetters, random)}${digit()}${letter()} ${digit()}${letter()}${digit()}`

	if (!normalizeCaPostalCode(postcode)) throw new Error(`generated an invalid CA postcode: ${postcode}`)

	return postcode
}

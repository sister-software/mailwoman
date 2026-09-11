/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   GENERATED — run `node packages/mailwoman/lib/dev-tools/codex/address-layouts.ts` to refresh. Do not edit by hand.
 *
 *   One layout per country, derived from libaddressinput's `fmt` skeleton (which fields print, in what order) and the
 *   street order read once from the OpenCage templates (which slot leads). The `fmt` each was derived from is quoted
 *   above it, so a reader can compare the two without opening the dataset.
 *
 *   The locales this project publishes weights for are NOT here: those are hand-authored in `address-layouts.ts` and
 *   checked against real addresses on a board, because a generated skeleton is a starting point rather than a verdict.
 */

// oxlint-disable max-lines -- one entry per country, each a template that reads in the order it prints

import { addr, numberFirstStreet, numberLastStreet, SLOTS, type AddressLayout } from "#address-layout"

const { attention, cedex, dependent_locality, locality, postcode, region, venue } = SLOTS

/**
 * Generated layouts, keyed by ISO 3166-1 alpha-2.
 */
export const GENERATED_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// %N%n%O%n%A%n%C%n%Z
	AC: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	AD: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%S
	AE: addr`${attention}
${venue}
${numberFirstStreet}
${region}`,

	// %N%n%O%n%A%n%C%n%Z
	AF: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C%n%Z
	AI: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%Z%n%C
	AL: addr`${attention}
${venue}
${numberLastStreet}
${postcode}
${locality}`,

	// %N%n%O%n%A%n%Z%n%C%n%S
	AM: addr`${attention}
${venue}
${numberFirstStreet}
${postcode}
${locality}
${region}`,

	// %N%n%O%n%A%n%Z %C%n%S
	AR: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}
${region}`,

	// %N%n%O%n%A%n%C %S %Z
	AS: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %O%n%N%n%A%n%Z %C
	AT: addr`${venue}
${attention}
${numberLastStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%nAX-%Z %C%nÅLAND
	AX: addr`${venue}
${attention}
${numberFirstStreet}
AX-${postcode} ${locality}`,

	// %N%n%O%n%A%nAZ %Z %C
	AZ: addr`${attention}
${venue}
${numberFirstStreet}
AZ ${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	BA: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C, %S %Z
	BB: addr`${attention}
${venue}
${numberFirstStreet}
${locality}, ${region} ${postcode}`,

	// %N%n%O%n%A%n%C - %Z
	BD: addr`${attention}
${venue}
${numberFirstStreet}
${locality} - ${postcode}`,

	// %O%n%N%n%A%n%Z %C
	BE: addr`${venue}
${attention}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %X
	BF: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${cedex}`,

	// %N%n%O%n%A%n%Z %C
	BG: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %Z
	BH: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %O%n%N%n%A%n%Z %C %X
	BL: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%C %Z
	BM: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%C %Z
	BN: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %O%n%N%n%A%n%D%n%C-%S%n%Z
	BR: addr`${venue}
${attention}
${numberLastStreet}
${dependent_locality}
${locality}-${region}
${postcode}`,

	// %N%n%O%n%A%n%C, %S
	BS: addr`${attention}
${venue}
${numberLastStreet}
${locality}, ${region}`,

	// %N%n%O%n%A%n%C %Z
	BT: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${postcode}`,

	// %O%n%N%n%A%n%Z, %C%n%S
	BY: addr`${venue}
${attention}
${numberLastStreet}
${postcode}, ${locality}
${region}`,

	// %N%n%O%n%A%n%C %S %Z
	CA: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %O%n%N%n%A%n%C %S %Z
	CC: addr`${venue}
${attention}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %O%n%N%n%A%nCH-%Z %C
	CH: addr`${venue}
${attention}
${numberLastStreet}
CH-${postcode} ${locality}`,

	// %N%n%O%n%X %A %C %X
	CI: addr`${attention}
${venue}
${cedex} ${numberFirstStreet} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%Z %C%n%S
	CL: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}
${region}`,

	// %N%n%O%n%A%n%D%n%C, %S, %Z
	CO: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}, ${region}, ${postcode}`,

	// %N%n%O%n%A%n%S, %C%n%Z
	CR: addr`${attention}
${venue}
${numberLastStreet}
${region}, ${locality}
${postcode}`,

	// %N%n%O%n%A%n%C %S%n%Z
	CU: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${region}
${postcode}`,

	// %N%n%O%n%A%n%Z %C%n%S
	CV: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}
${region}`,

	// %O%n%N%n%A%n%C %S %Z
	CX: addr`${venue}
${attention}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%n%Z %C
	CY: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	CZ: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	DK: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	DO: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	DZ: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z%n%C
	EC: addr`${attention}
${venue}
${numberLastStreet}
${postcode}
${locality}`,

	// %N%n%O%n%A%n%Z %C %S
	EE: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality} ${region}`,

	// %N%n%O%n%A%n%C%n%S%n%Z
	EG: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${region}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	EH: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	ET: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%nFI-%Z %C
	FI: addr`${venue}
${attention}
${numberLastStreet}
FI-${postcode} ${locality}`,

	// %N%n%O%n%A%n%C%n%Z
	FK: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C %S %Z
	FM: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%nFO%Z %C
	FO: addr`${attention}
${venue}
${numberLastStreet}
FO${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	GE: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%n%Z %C %X
	GF: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%C%nGUERNSEY%n%Z
	GG: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%nGIBRALTAR%n%Z
	GI: addr`${attention}
${venue}
${numberFirstStreet}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	GL: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%Z %A %C
	GN: addr`${attention}
${venue}
${postcode} ${numberFirstStreet} ${locality}`,

	// %O%n%N%n%A%n%Z %C %X
	GP: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%Z %C
	GR: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%n%C%n%Z
	GS: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%Z- %C
	GT: addr`${attention}
${venue}
${numberLastStreet}
${postcode}- ${locality}`,

	// %N%n%O%n%A%n%C %Z
	GU: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%Z %C
	GW: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %S%n%C%n%A%n%O%n%N
	HK: addr`${region}
${locality}
${numberFirstStreet}
${venue}
${attention}`,

	// %O%n%N%n%A%n%C %S %Z
	HM: addr`${venue}
${attention}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%n%C, %S%n%Z
	HN: addr`${attention}
${venue}
${numberLastStreet}
${locality}, ${region}
${postcode}`,

	// %N%n%O%n%A%nHR-%Z %C
	HR: addr`${attention}
${venue}
${numberLastStreet}
HR-${postcode} ${locality}`,

	// %N%n%O%n%A%nHT%Z %C
	HT: addr`${attention}
${venue}
${numberLastStreet}
HT${postcode} ${locality}`,

	// %N%n%O%n%C%n%A%n%Z
	HU: addr`${attention}
${venue}
${locality}
${numberLastStreet}
${postcode}`,

	// %N%n%O%n%A%n%C%n%S %Z
	ID: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${region} ${postcode}`,

	// %N%n%O%n%A%n%D%n%C%n%S%n%Z
	IE: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${postcode}`,

	// %N%n%O%n%A%n%C %Z
	IL: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%C%n%Z
	IM: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C%n%Z
	IO: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %O%n%N%n%A%n%C, %S%n%Z
	IQ: addr`${venue}
${attention}
${numberFirstStreet}
${locality}, ${region}
${postcode}`,

	// %O%n%N%n%S%n%C, %D%n%A%n%Z
	IR: addr`${venue}
${attention}
${region}
${locality}, ${dependent_locality}
${numberLastStreet}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	IS: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C%nJERSEY%n%Z
	JE: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C%n%S %X
	JM: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${region} ${cedex}`,

	// %N%n%O%n%A%n%C %Z
	JO: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%C%n%Z
	KE: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	KG: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %Z
	KH: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%S%n%C
	KI: addr`${attention}
${venue}
${numberLastStreet}
${region}
${locality}`,

	// %N%n%O%n%A%n%C, %S
	KN: addr`${attention}
${venue}
${numberFirstStreet}
${locality}, ${region}`,

	// %Z%n%S%n%C%n%A%n%O%n%N
	KP: addr`${postcode}
${region}
${locality}
${numberLastStreet}
${venue}
${attention}`,

	// %S %C%D%n%A%n%O%n%N%n%Z
	KR: addr`${region} ${locality}${dependent_locality}
${numberLastStreet}
${venue}
${attention}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	KW: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%S %Z
	KY: addr`${attention}
${venue}
${numberFirstStreet}
${region} ${postcode}`,

	// %Z%n%S%n%C%n%A%n%O%n%N
	KZ: addr`${postcode}
${region}
${locality}
${numberLastStreet}
${venue}
${attention}`,

	// %N%n%O%n%A%n%Z %C
	LA: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %Z
	LB: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %O%n%N%n%A%nFL-%Z %C
	LI: addr`${venue}
${attention}
${numberFirstStreet}
FL-${postcode} ${locality}`,

	// %N%n%O%n%A%n%C%n%Z
	LK: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	LR: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %Z
	LS: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %O%n%N%n%A%nLT-%Z %C %S
	LT: addr`${venue}
${attention}
${numberLastStreet}
LT-${postcode} ${locality} ${region}`,

	// %O%n%N%n%A%nL-%Z %C
	LU: addr`${venue}
${attention}
${numberFirstStreet}
L-${postcode} ${locality}`,

	// %N%n%O%n%A%n%S%n%C, %Z
	LV: addr`${attention}
${venue}
${numberLastStreet}
${region}
${locality}, ${postcode}`,

	// %N%n%O%n%A%n%Z %C
	MA: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%nMC-%Z %C %X
	MC: addr`${attention}
${venue}
${numberFirstStreet}
MC-${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%nMD-%Z %C
	MD: addr`${attention}
${venue}
${numberLastStreet}
MD-${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	ME: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%n%Z %C %X
	MF: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%Z %C
	MG: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %S %Z
	MH: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%n%Z %C
	MK: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C, %Z
	MM: addr`${attention}
${venue}
${numberFirstStreet}
${locality}, ${postcode}`,

	// %N%n%O%n%A%n%C%n%S %Z
	MN: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${region} ${postcode}`,

	// %A%n%O%n%N
	MO: addr`${numberLastStreet}
${venue}
${attention}`,

	// %N%n%O%n%A%n%C %S %Z
	MP: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %O%n%N%n%A%n%Z %C %X
	MQ: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%C %Z
	MT: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%Z%n%C
	MU: addr`${attention}
${venue}
${numberFirstStreet}
${postcode}
${locality}`,

	// %N%n%O%n%A%n%C %Z
	MV: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%C %X
	MW: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${cedex}`,

	// %N%n%O%n%A%n%D%n%Z %C, %S
	MX: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}, ${region}`,

	// %N%n%O%n%A%n%D%n%Z %C%n%S
	MY: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${region}`,

	// %N%n%O%n%A%n%Z %C%S
	MZ: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}${region}`,

	// %N%n%O%n%A%n%C%n%Z
	NA: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %O%n%N%n%A%n%Z %C %X
	NC: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%Z %C
	NE: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%n%C %S %Z
	NF: addr`${venue}
${attention}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%n%D%n%C %Z%n%S
	NG: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${region}`,

	// %N%n%O%n%A%n%Z%n%C, %S
	NI: addr`${attention}
${venue}
${numberLastStreet}
${postcode}
${locality}, ${region}`,

	// %O%n%N%n%A%n%Z %C
	NL: addr`${venue}
${attention}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	NO: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %Z
	NP: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%S
	NR: addr`${attention}
${venue}
${numberFirstStreet}
${region}`,

	// %N%n%O%n%A%n%Z%n%C
	OM: addr`${attention}
${venue}
${numberFirstStreet}
${postcode}
${locality}`,

	// %N%n%O%n%A%n%C%n%S
	PA: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${region}`,

	// %N%n%O%n%A%n%C %Z%n%S
	PE: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${postcode}
${region}`,

	// %N%n%O%n%A%n%Z %C %S
	PF: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality} ${region}`,

	// %N%n%O%n%A%n%C %Z %S
	PG: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode} ${region}`,

	// %N%n%O%n%A%n%D, %C%n%Z %S
	PH: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}, ${locality}
${postcode} ${region}`,

	// %N%n%O%n%A%n%D%n%C-%Z
	PK: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}-${postcode}`,

	// %N%n%O%n%A%n%Z %C
	PL: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%n%Z %C %X
	PM: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%C%n%Z
	PN: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C PR %Z
	PR: addr`${attention}
${venue}
${numberFirstStreet}
${locality} PR ${postcode}`,

	// %N%n%O%n%A%n%Z %C
	PT: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %S %Z
	PW: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%n%Z %C
	PY: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%n%Z %C %X
	RE: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%Z %S %C
	RO: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${region} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	RS: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C%n%S%n%Z
	RU: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${region}
${postcode}`,

	// %N%n%O%n%A%n%C %Z
	SA: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%C%n%S
	SC: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${region}`,

	// %N%n%O%n%A%n%C%n%Z
	SD: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${postcode}`,

	// %O%n%N%n%A%nSE-%Z %C
	SE: addr`${venue}
${attention}
${numberLastStreet}
SE-${postcode} ${locality}`,

	// %N%n%O%n%A%nSINGAPORE %Z
	SG: addr`${attention}
${venue}
${numberFirstStreet}
SINGAPORE ${postcode}`,

	// %N%n%O%n%A%n%C%n%Z
	SH: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%nSI-%Z %C
	SI: addr`${attention}
${venue}
${numberLastStreet}
SI-${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	SJ: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	SK: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	SM: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	SN: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C, %S %Z
	SO: addr`${attention}
${venue}
${numberLastStreet}
${locality}, ${region} ${postcode}`,

	// %N%n%O%n%A%n%C%n%S
	SR: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${region}`,

	// %N%n%O%n%A%n%Z-%C%n%S
	SV: addr`${attention}
${venue}
${numberLastStreet}
${postcode}-${locality}
${region}`,

	// %N%n%O%n%A%n%C%n%Z
	SZ: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C%n%Z
	TA: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C%n%Z
	TC: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%D %C%n%S %Z
	TH: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality} ${locality}
${region} ${postcode}`,

	// %N%n%O%n%A%n%Z %C
	TJ: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	TM: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C
	TN: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%Z %C/%S
	TR: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}/${region}`,

	// %N%n%O%n%A%n%C%n%S
	TV: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${region}`,

	// %Z%n%S%C%n%A%n%O%n%N
	TW: addr`${postcode}
${region}${locality}
${numberLastStreet}
${venue}
${attention}`,

	// %N%n%O%n%A%n%Z %C
	TZ: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C%n%S%n%Z
	UA: addr`${attention}
${venue}
${numberLastStreet}
${locality}
${region}
${postcode}`,

	// %N%n%O%n%A%n%C %S %Z
	UM: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%n%Z %C %S
	UY: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality} ${region}`,

	// %N%n%O%n%A%n%Z %C%n%S
	UZ: addr`${attention}
${venue}
${numberLastStreet}
${postcode} ${locality}
${region}`,

	// %N%n%O%n%A%n%Z %C
	VA: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %N%n%O%n%A%n%C %Z
	VC: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${postcode}`,

	// %N%n%O%n%A%n%C %Z, %S
	VE: addr`${attention}
${venue}
${numberLastStreet}
${locality} ${postcode}, ${region}`,

	// %N%n%O%n%A%n%C%n%Z
	VG: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%C %S %Z
	VI: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${region} ${postcode}`,

	// %N%n%O%n%A%n%C%n%S %Z
	VN: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${region} ${postcode}`,

	// %O%n%N%n%A%n%Z %C %X
	WF: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%Z %C
	XK: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,

	// %O%n%N%n%A%n%Z %C %X
	YT: addr`${venue}
${attention}
${numberFirstStreet}
${postcode} ${locality} ${cedex}`,

	// %N%n%O%n%A%n%D%n%C%n%Z
	ZA: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${postcode}`,

	// %N%n%O%n%A%n%Z %C
	ZM: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}`,
}

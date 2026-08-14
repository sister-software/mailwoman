/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Form 499's `note1`/`note2`/`note3` columns — the filer lifecycle log.
 *
 *   The Form 499 filer database ships three free-text note columns that nothing in this crosswalk has ever
 *   read. They are not free text. Across the 2025-12-07 vintage's 19,852 filers, 11,533 carry at least one
 *   note and every note in the file matches ONE OF EIGHT SHAPES — 3,085 distinct strings, eight templates,
 *   no stragglers. That makes them a structured lifecycle log wearing a prose costume.
 *
 *   Two of the eight are not annotations at all, they are DATA the schema already has columns for:
 *
 *   - `No longer active as of 9/8/2013` (9,706 rows) is a `valid_to`. Without it every ceased filer reads
 *     as open-ended, and a carrier dissolved in 2013 is presented in the present tense.
 *   - `Replaced by filer 821002` (2,826 rows) is a SUPERSESSION EDGE between two filers. 99.8% of those
 *     targets resolve to a filer ID present in the same file, the chains run 1-5 deep, and none of them
 *     cycle. That is the identity chain the spine spec wanted, already written down.
 *
 *   The other six are cessation REASONS, and they are the FCC's own words about a filer's status. They are
 *   carried as a small closed vocabulary plus the verbatim source string, never as a derived judgment of
 *   our own — `Form499Lifecycle.notes` always holds exactly what the file said. This matters most for
 *   {@linkcode Form499CessationReason.Bankruptcy}: it is a quoted federal record with provenance, not a
 *   claim this project makes about a company.
 *
 *   **Nothing here infers.** A note that matches no shape is counted in
 *   {@link Form499Lifecycle.unrecognized} and kept verbatim in `notes`; it never becomes a guessed reason,
 *   and a future vintage that adds a ninth template shows up as a rising count rather than as silence.
 */

/**
 * The cessation vocabulary, keyed to the eight note templates. A plain const object rather than an `enum` —
 * `erasableSyntaxOnly` is on repo-wide.
 */
export const Form499CessationReason = {
	/**
	 * `No longer active as of <date>`. Carries the date, which becomes {@link Form499Lifecycle.ceasedAt}.
	 */
	NoLongerActive: "no-longer-active",
	/**
	 * `Replaced by filer <id>`. Carries the successor, which becomes {@link Form499Lifecycle.replacedByForm499ID}.
	 */
	ReplacedByFiler: "replaced-by-filer",
	/**
	 * `This company still exists, however it is no longer providing telecommunications services.` The entity survives;
	 * only the telecom operation ended. Distinct from {@linkcode Form499CessationReason.OutOfBusiness} and the difference
	 * is load-bearing — one of these companies can still be somebody's parent.
	 */
	ExitedTelecom: "exited-telecom",
	/**
	 * `This company has gone out of business in its entirety (no sale of assets involved).`
	 */
	OutOfBusiness: "out-of-business",
	/**
	 * `All assets of this company have been sold to another party.` The FCC does not name the party.
	 */
	AssetsSold: "assets-sold",
	/**
	 * `This legal entity accout has been closed because their Form 499 filing is now submitted on a consolidated basis.`
	 * (`accout` is the source's own typo, matched verbatim below.) The entity did not cease — its filing moved under a
	 * parent's, which is a family signal rather than a death certificate.
	 */
	AccountConsolidated: "account-consolidated",
	/**
	 * `This company has been absorbed by another filing entity.`
	 */
	AbsorbedByFiler: "absorbed-by-filer",
	/**
	 * `This company has filed for Chapter <n> bankruptcy protection.` A quoted federal record. Never rendered as a status
	 * this project asserts, and never inferred from anything but this exact sentence.
	 */
	Bankruptcy: "bankruptcy",
} as const

export type Form499CessationReasonValue = (typeof Form499CessationReason)[keyof typeof Form499CessationReason]

/**
 * What {@linkcode parseForm499Notes} recovered from one filer's three note cells.
 */
export interface Form499Lifecycle {
	/**
	 * Every non-empty note, verbatim and in column order. The source text is never discarded — a reason code is a lossy
	 * summary of it, and an auditor asking "what did the FCC actually say" must not have to refetch the workbook.
	 */
	notes: string[]
	/**
	 * ISO `YYYY-MM-DD` date this filer stopped being active, from `No longer active as of <date>`. Absent when no note
	 * stated one.
	 *
	 * ISO because this is destined for `valid_to`, which `assertISODate` enforces and which every `asOf`-scoped read
	 * compares as a plain string. The source states `M/D/YYYY`, which sorts wrong and fails that assertion.
	 */
	ceasedAt?: string
	/**
	 * The Form 499 filer ID that superseded this one, from `Replaced by filer <id>`. A supersession edge, not an
	 * ownership one: it says this registration became that registration, and nothing about who owns either.
	 */
	replacedByForm499ID?: string
	/**
	 * Every recognized reason, deduplicated, in the order first seen. A filer commonly carries two or three — a date, a
	 * replacement, and a reason are three separate notes on the same row.
	 */
	reasons: Form499CessationReasonValue[]
	/**
	 * Notes matching none of the eight templates. Always `0` for the 2025-12-07 vintage; a non-zero count in a later
	 * vintage means the FCC added a template and this file needs revisiting. Counted rather than silently dropped so that
	 * fact can be measured instead of assumed.
	 */
	unrecognized: number
}

const NO_LONGER_ACTIVE_PATTERN = /^no longer active as of (\d{1,2})\/(\d{1,2})\/(\d{4})$/i
const REPLACED_BY_FILER_PATTERN = /^replaced by filer (\d+)$/i

/**
 * The six templates carrying no payload beyond their own meaning. Matched on the whole trimmed string,
 * case-insensitively — never by keyword — for the same reason `exhibit21.ts` matches whole header cells: a substring
 * test for "bankruptcy" or "sold" would fire on a sentence the FCC has not written yet.
 */
const FIXED_NOTE_PATTERNS = [
	[
		/^this company still exists, however it is no longer providing telecommunications services\.$/i,
		Form499CessationReason.ExitedTelecom,
	],
	[
		/^this company has gone out of business in its entirety \(no sale of assets involved\)\.$/i,
		Form499CessationReason.OutOfBusiness,
	],
	[/^all assets of this company have been sold to another party\.$/i, Form499CessationReason.AssetsSold],
	[
		// `accout` is the source's typo and is matched as spelled. A tolerant `accou?nt` would also admit a
		// corrected future spelling, but silently — a vintage that fixes the typo should surface as an
		// `unrecognized` count so the change is noticed rather than absorbed.
		/^this legal entity accout has been closed because their form \d+ filing is now submitted on a consolidated basis\.$/i,
		Form499CessationReason.AccountConsolidated,
	],
	[/^this company has been absorbed by another filing entity\.$/i, Form499CessationReason.AbsorbedByFiler],
	[/^this company has filed for chapter \d+ bankruptcy protection\.$/i, Form499CessationReason.Bankruptcy],
] as const satisfies ReadonlyArray<readonly [RegExp, Form499CessationReasonValue]>

/**
 * Pad a 1-or-2-digit month/day to two digits.
 */
function pad2(value: string): string {
	return value.padStart(2, "0")
}

/**
 * Parse one filer's note cells into its lifecycle. Accepts the three raw cells in column order;
 * `null`/`undefined`/blank entries are skipped, and any number of cells is tolerated so a future vintage adding `note4`
 * needs no signature change.
 *
 * Never throws. A note this does not recognize is counted, not guessed at — see {@link Form499Lifecycle.unrecognized}.
 */
export function parseForm499Notes(rawNotes: ReadonlyArray<string | null | undefined>): Form499Lifecycle {
	const notes: string[] = []
	const reasons: Form499CessationReasonValue[] = []
	let ceasedAt: string | undefined
	let replacedByForm499ID: string | undefined
	let unrecognized = 0

	const addReason = (reason: Form499CessationReasonValue): void => {
		if (!reasons.includes(reason)) {
			reasons.push(reason)
		}
	}

	for (const raw of rawNotes) {
		const note = (raw ?? "").trim()

		if (!note) continue

		notes.push(note)

		const active = NO_LONGER_ACTIVE_PATTERN.exec(note)

		if (active) {
			const [, month, day, year] = active

			// Last one wins if a row somehow states two dates: the notes are ordered and a later cell is the
			// later statement. No such row exists in the 2025-12-07 vintage.
			ceasedAt = `${year}-${pad2(month!)}-${pad2(day!)}`

			addReason(Form499CessationReason.NoLongerActive)

			continue
		}

		const replaced = REPLACED_BY_FILER_PATTERN.exec(note)

		if (replaced) {
			replacedByForm499ID = replaced[1]

			addReason(Form499CessationReason.ReplacedByFiler)

			continue
		}

		const fixed = FIXED_NOTE_PATTERNS.find(([pattern]) => pattern.test(note))

		if (fixed) {
			addReason(fixed[1])

			continue
		}

		unrecognized++
	}

	const lifecycle: Form499Lifecycle = { notes, reasons, unrecognized }

	if (ceasedAt) {
		lifecycle.ceasedAt = ceasedAt
	}

	if (replacedByForm499ID) {
		lifecycle.replacedByForm499ID = replacedByForm499ID
	}

	return lifecycle
}

/**
 * True when this filer's notes state it is no longer an active Form 499 filer.
 *
 * Deliberately NOT `reasons.length > 0`: {@linkcode Form499CessationReason.AccountConsolidated} means the filing moved
 * under a parent's and {@linkcode Form499CessationReason.ExitedTelecom} means the company still exists — reading either
 * as "this entity is gone" would erase a live company that is somebody's parent. A `ceasedAt` date, or an explicit
 * out-of-business/absorbed/replaced statement, is what this reports on.
 */
export function isCeasedFiler(lifecycle: Form499Lifecycle): boolean {
	if (lifecycle.ceasedAt) return true

	return lifecycle.reasons.some(
		(reason) =>
			reason === Form499CessationReason.OutOfBusiness ||
			reason === Form499CessationReason.AbsorbedByFiler ||
			reason === Form499CessationReason.ReplacedByFiler
	)
}

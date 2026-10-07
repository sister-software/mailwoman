/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Form 499's `note1`/`note2`/`note3` columns form a structured lifecycle log rather than free text.
 * Every note among the 19,852 filers in the 2025-12-07 vintage matches one of eight templates.
 * The parser stores a closed-vocabulary value beside the verbatim source string. It records a note
 * matching no template in {@link Form499Lifecycle.unrecognized} while preserving the source string.
 */

/**
 * The cessation vocabulary, keyed to the eight note templates.
 *
 * A plain const object because `erasableSyntaxOnly` is on repo-wide.
 */
export const Form499CessationReason = {
	/**
	 * `No longer active as of <date>`, whose date becomes {@link Form499Lifecycle.ceasedAt}.
	 */
	NoLongerActive: "no-longer-active",
	/**
	 * `Replaced by filer <id>`.
	 *
	 * The successor becomes {@link Form499Lifecycle.replacedByForm499ID}.
	 */
	ReplacedByFiler: "replaced-by-filer",
	/**
	 * The entity survives while its telecom operation ends.
	 *
	 * This distinguishes it it from {@linkcode Form499CessationReason.OutOfBusiness}
	 * since one of these companies can still be somebody's parent.
	 */
	ExitedTelecom: "exited-telecom",
	/**
	 * `This company has gone out of business in its entirety (no sale of assets involved).`
	 */
	OutOfBusiness: "out-of-business",
	/**
	 * `All assets of this company have been sold to another party.`, with no field
	 * for the party the FCC does not name.
	 */
	AssetsSold: "assets-sold",
	/**
	 * `This legal entity accout has been closed because their Form 499 filing is now submitted on a
	 * consolidated basis.`; `accout` is the source's typo and the pattern matches it verbatim.
	 * The entity moved under a parent's filing rather than ceasing operations.
	 */
	AccountConsolidated: "account-consolidated",
	/**
	 * `This company has been absorbed by another filing entity.`
	 */
	AbsorbedByFiler: "absorbed-by-filer",
	/**
	 * `This company has filed for Chapter <n> bankruptcy protection.`, a quoted federal
	 * record never rendered as a status this project asserts.
	 */
	Bankruptcy: "bankruptcy",
} as const

export type Form499CessationReasonValue = (typeof Form499CessationReason)[keyof typeof Form499CessationReason]

/**
 * What {@linkcode parseForm499Notes} recovered from one filer's three note cells.
 */
export interface Form499Lifecycle {
	/**
	 * Every non-empty note, verbatim and in column order.
	 *
	 * The source text is never discarded because a reason code is a lossy summary of it.
	 */
	notes: string[]
	/**
	 * ISO `yyyy-MM-dd` date this filer stopped being active, because `valid_to` is
	 * enforced by `assertISODate` and the source's `M/D/yyyy` sorts wrong.
	 */
	ceasedAt: string | null
	/**
	 * The Form 499 filer ID that superseded this one, a supersession edge rather than an ownership one.
	 */
	replacedByForm499ID: string | null
	/**
	 * Every recognized reason, deduplicated, in the order first seen.
	 *
	 * Separate notes on one row can record a date and replacement.
	 * Another note can record a reason.
	 */
	reasons: Form499CessationReasonValue[]
	/**
	 * Notes matching none of the eight templates.
	 *
	 * Counted rather than silently dropped, so the `0` this 2025-12-07 vintage shows
	 * becomes a measured rise when a later vintage adds a ninth template.
	 */
	unrecognized: number
}

const NO_LONGER_ACTIVE_PATTERN = /^no longer active as of (\d{1,2})\/(\d{1,2})\/(\d{4})$/i
const REPLACED_BY_FILER_PATTERN = /^replaced by filer (\d+)$/i

/**
 * The six templates carrying no payload beyond their own meaning, matched on the
 * whole trimmed string case-insensitively so a substring test for "bankruptcy"
 * or "sold" cannot fire on a sentence the FCC has not written yet.
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
		// `accout` is the source's typo and is matched as spelled.
		// A tolerant `accou?nt` pattern would silently admit a corrected future spelling.
		// That spelling should instead increase the `unrecognized` count.
		/^this legal entity accout has been closed because their form \d+ filing is now submitted on a consolidated basis\.$/i,
		Form499CessationReason.AccountConsolidated,
	],
	[/^this company has been absorbed by another filing entity\.$/i, Form499CessationReason.AbsorbedByFiler],
	[/^this company has filed for chapter \d+ bankruptcy protection\.$/i, Form499CessationReason.Bankruptcy],
] as const satisfies ReadonlyArray<readonly [RegExp, Form499CessationReasonValue]>

function pad2(value: string): string {
	return value.padStart(2, "0")
}

/**
 * Parses one filer's note cells into its lifecycle, skipping blank cells and counting
 * rather than guessing at a note it does not recognize.
 */
export function parseForm499Notes(rawNotes: ReadonlyArray<string | null | undefined>): Form499Lifecycle {
	const notes: string[] = []
	const reasons: Form499CessationReasonValue[] = []
	let ceasedAt: string | null = null
	let replacedByForm499ID: string | null = null
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

			// Last one wins if a row somehow states two dates, since the notes are ordered
			// and a later cell is the later statement.
			ceasedAt = `${year}-${pad2(month!)}-${pad2(day!)}`

			addReason(Form499CessationReason.NoLongerActive)

			continue
		}

		const replaced = REPLACED_BY_FILER_PATTERN.exec(note)

		if (replaced) {
			replacedByForm499ID = replaced[1] ?? null

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

	return { notes, reasons, unrecognized, ceasedAt: ceasedAt || null, replacedByForm499ID: replacedByForm499ID || null }
}

/**
 * True when this filer's notes state it is no longer an active Form 499 filer.
 * deliberately not `reasons.length > 0`, because `AccountConsolidated` and `ExitedTelecom`
 * leave a live company that can still be somebody's parent.
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

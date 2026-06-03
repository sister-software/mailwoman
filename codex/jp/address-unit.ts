/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Japan's analog of a "street-type" module — except the lesson here is the absence. Where
 *   `us/street-suffix.ts` and `de/street-type.ts` exist to recognize the named-street part of an
 *   address, Japan has **no street names** to recognize. A Japanese address is built from nested
 *   administrative units and numbered blocks/lots, written largest-to-smallest:
 *
 *   ```
 *   東京都 千代田区 千代田 1丁目 1番 1号
 *   Tokyo-to · Chiyoda-ku · Chiyoda · 1-chōme · 1-ban · 1-gō
 * ```
 *
 *   So instead of a street-suffix table this file ships two marker sets:
 *
 *   - {@link JP_ADMIN_SUFFIXES} — the kanji that close an administrative-area name (都/道/府/県 at the
 *       prefecture level, then 市/区/郡/町/村 for city / ward / district / town / village). These are
 *       the Japanese equivalent of a US street suffix in the parsing sense: the token-final marker
 *       that tells you what KIND of unit the preceding name is.
 *   - {@link JP_BLOCK_MARKERS} — the markers that close the numbered tail (丁目 / 番地 / 番 / 号), the part
 *       that actually does the "house number" job in the absence of streets.
 *
 *   Note the reverse field order: the admin suffixes appear FIRST in the string (prefecture leads),
 *   and the block markers LAST — the mirror image of a US line, where the house number leads and
 *   the ZIP trails. See `postal-code.ts` for why, with no street name, the postcode is the primary
 *   anchor.
 */

/**
 * The kanji suffixes that close an administrative-area name, largest unit to smallest:
 *
 * - 都 (to) — metropolis; only Tokyo.
 * - 道 (dō) — circuit; only Hokkaido.
 * - 府 (fu) — urban prefecture; Osaka and Kyoto.
 * - 県 (ken) — prefecture; the other 43.
 * - 市 (shi) — city.
 * - 区 (ku) — ward (a subdivision of a designated city, e.g. Tokyo's 23 special wards).
 * - 郡 (gun) — district / county (rural grouping of towns and villages).
 * - 町 (chō / machi) — town.
 * - 村 (son / mura) — village.
 */
export const JP_ADMIN_SUFFIXES = ["都", "道", "府", "県", "市", "区", "郡", "町", "村"] as const

/** A single administrative-area suffix kanji (`都`, `市`, `区`, …). */
export type JapaneseAdminSuffix = (typeof JP_ADMIN_SUFFIXES)[number]

/**
 * The markers that close the numbered tail of an address — Japan's stand-in for a house number,
 * since there is no named street to hang one on:
 *
 * - 丁目 (chōme) — a district block within a neighbourhood.
 * - 番地 (banchi) — a lot number.
 * - 番 (ban) — block number (the `番` in the modern `chōme-ban-gō` triple).
 * - 号 (gō) — building number (the final element of the triple).
 */
export const JP_BLOCK_MARKERS = ["丁目", "番地", "番", "号"] as const

/** A numbered-tail marker (`丁目`, `番地`, `番`, `号`). */
export type JapaneseBlockMarker = (typeof JP_BLOCK_MARKERS)[number]

const ADMIN_SUFFIX_SET: ReadonlySet<string> = new Set(JP_ADMIN_SUFFIXES)

/**
 * True when a single kanji is one of the {@link JP_ADMIN_SUFFIXES} admin-area markers (`都`, `市`,
 * `区`, …). Strictly single-character: a multi-character input (even one ending in a suffix) is not
 * a suffix on its own.
 */
export function isJapaneseAdminSuffix(ch: unknown): ch is JapaneseAdminSuffix {
	return typeof ch === "string" && ADMIN_SUFFIX_SET.has(ch)
}

/**
 * Strip a trailing admin-area suffix kanji from a place name, exposing the bare name (`東京都` → `東京`,
 * `大阪市` → `大阪`, `千代田区` → `千代田`). Leaves a name untouched if it does not end in an admin suffix.
 *
 * Hokkaido (`北海道`) is the deliberate exception: its name ends in 道 but is indivisible, so it is
 * returned whole rather than clipped to `北海` — mirroring the same carve-out in `prefecture.ts`.
 */
export function stripAdminSuffix(name: string): string {
	if (typeof name !== "string" || name.length === 0) return name
	if (name === "北海道") return name
	const last = name[name.length - 1]!
	return ADMIN_SUFFIX_SET.has(last) ? name.slice(0, -1) : name
}

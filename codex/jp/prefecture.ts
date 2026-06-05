/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The 47 Japanese prefectures (都道府県, todōfuken), keyed by their ISO 3166-2:JP code — the two-digit
 *   numeric string `"01"`..`"47"` standing in for `JP-01`..`JP-47`.
 *
 *   The contrast with `fr/region.ts`, `de/bundesland.ts`, and `us/state.ts` is in the name itself.
 *   "都道府県" is four kanji because the top-level admin unit comes in four legally distinct flavours,
 *   even though all 47 are peers in practice:
 *
 *   - 都 (to, "metropolis") — exactly **1**: Tokyo (東京都). The capital's special form.
 *   - 道 (dō, "circuit") — exactly **1**: Hokkaido (北海道). A historical term; the name already ends in 道,
 *       so Hokkaido is written and indexed whole, never stripped to "北海".
 *   - 府 (fu, "urban prefecture") — exactly **2**: Osaka (大阪府) and Kyoto (京都府). The old imperial capital
 *       region.
 *   - 県 (ken, "prefecture") — the remaining **43**. The ordinary case.
 *
 *   Unlike a French région or a German Bundesland, the prefecture DOES appear on a normal address
 *   line: a Japanese address is written largest-to-smallest (prefecture → city → ward → block), so
 *   the prefecture is the first thing written, not an inferred-from-postcode afterthought. See
 *   `postal-code.ts` for why the postcode is nonetheless the single most reliable anchor.
 */

/** A to/dō/fu/ken classification of the top-level admin unit. */
export type JapanesePrefectureType = "to" | "do" | "fu" | "ken"

/** Per-prefecture record: ISO 3166-2:JP numeric code + kanji + romaji + to/dō/fu/ken type. */
export interface JapanesePrefectureInfo {
	/** ISO 3166-2:JP code without the `JP-` prefix: a two-digit numeric string (`"13"` for `JP-13`). */
	code: string
	/** Kanji name, including its 都/道/府/県 suffix (e.g. `東京都`). */
	kanji: string
	/** Macron-free romaji name, suffix-less (e.g. `Tokyo`). */
	romaji: string
	/** Which of the four flavours of top-level unit this is. */
	type: JapanesePrefectureType
}

/**
 * ISO 3166-2:JP numeric code → info, for all 47 prefectures. Ordered by code, which is also the
 * conventional north-to-south-ish ordering (Hokkaido `01` at the top, Okinawa `47` at the bottom).
 */
export const JP_PREFECTURES = {
	"01": { code: "01", kanji: "北海道", romaji: "Hokkaido", type: "do" },
	"02": { code: "02", kanji: "青森県", romaji: "Aomori", type: "ken" },
	"03": { code: "03", kanji: "岩手県", romaji: "Iwate", type: "ken" },
	"04": { code: "04", kanji: "宮城県", romaji: "Miyagi", type: "ken" },
	"05": { code: "05", kanji: "秋田県", romaji: "Akita", type: "ken" },
	"06": { code: "06", kanji: "山形県", romaji: "Yamagata", type: "ken" },
	"07": { code: "07", kanji: "福島県", romaji: "Fukushima", type: "ken" },
	"08": { code: "08", kanji: "茨城県", romaji: "Ibaraki", type: "ken" },
	"09": { code: "09", kanji: "栃木県", romaji: "Tochigi", type: "ken" },
	"10": { code: "10", kanji: "群馬県", romaji: "Gunma", type: "ken" },
	"11": { code: "11", kanji: "埼玉県", romaji: "Saitama", type: "ken" },
	"12": { code: "12", kanji: "千葉県", romaji: "Chiba", type: "ken" },
	"13": { code: "13", kanji: "東京都", romaji: "Tokyo", type: "to" },
	"14": { code: "14", kanji: "神奈川県", romaji: "Kanagawa", type: "ken" },
	"15": { code: "15", kanji: "新潟県", romaji: "Niigata", type: "ken" },
	"16": { code: "16", kanji: "富山県", romaji: "Toyama", type: "ken" },
	"17": { code: "17", kanji: "石川県", romaji: "Ishikawa", type: "ken" },
	"18": { code: "18", kanji: "福井県", romaji: "Fukui", type: "ken" },
	"19": { code: "19", kanji: "山梨県", romaji: "Yamanashi", type: "ken" },
	"20": { code: "20", kanji: "長野県", romaji: "Nagano", type: "ken" },
	"21": { code: "21", kanji: "岐阜県", romaji: "Gifu", type: "ken" },
	"22": { code: "22", kanji: "静岡県", romaji: "Shizuoka", type: "ken" },
	"23": { code: "23", kanji: "愛知県", romaji: "Aichi", type: "ken" },
	"24": { code: "24", kanji: "三重県", romaji: "Mie", type: "ken" },
	"25": { code: "25", kanji: "滋賀県", romaji: "Shiga", type: "ken" },
	"26": { code: "26", kanji: "京都府", romaji: "Kyoto", type: "fu" },
	"27": { code: "27", kanji: "大阪府", romaji: "Osaka", type: "fu" },
	"28": { code: "28", kanji: "兵庫県", romaji: "Hyogo", type: "ken" },
	"29": { code: "29", kanji: "奈良県", romaji: "Nara", type: "ken" },
	"30": { code: "30", kanji: "和歌山県", romaji: "Wakayama", type: "ken" },
	"31": { code: "31", kanji: "鳥取県", romaji: "Tottori", type: "ken" },
	"32": { code: "32", kanji: "島根県", romaji: "Shimane", type: "ken" },
	"33": { code: "33", kanji: "岡山県", romaji: "Okayama", type: "ken" },
	"34": { code: "34", kanji: "広島県", romaji: "Hiroshima", type: "ken" },
	"35": { code: "35", kanji: "山口県", romaji: "Yamaguchi", type: "ken" },
	"36": { code: "36", kanji: "徳島県", romaji: "Tokushima", type: "ken" },
	"37": { code: "37", kanji: "香川県", romaji: "Kagawa", type: "ken" },
	"38": { code: "38", kanji: "愛媛県", romaji: "Ehime", type: "ken" },
	"39": { code: "39", kanji: "高知県", romaji: "Kochi", type: "ken" },
	"40": { code: "40", kanji: "福岡県", romaji: "Fukuoka", type: "ken" },
	"41": { code: "41", kanji: "佐賀県", romaji: "Saga", type: "ken" },
	"42": { code: "42", kanji: "長崎県", romaji: "Nagasaki", type: "ken" },
	"43": { code: "43", kanji: "熊本県", romaji: "Kumamoto", type: "ken" },
	"44": { code: "44", kanji: "大分県", romaji: "Oita", type: "ken" },
	"45": { code: "45", kanji: "宮崎県", romaji: "Miyazaki", type: "ken" },
	"46": { code: "46", kanji: "鹿児島県", romaji: "Kagoshima", type: "ken" },
	"47": { code: "47", kanji: "沖縄県", romaji: "Okinawa", type: "ken" },
} as const satisfies Record<string, JapanesePrefectureInfo>

/** An ISO 3166-2:JP prefecture code (`"01"`..`"47"`). */
export type JapanesePrefectureCode = keyof typeof JP_PREFECTURES

const PREFECTURE_CODE_SET: ReadonlySet<string> = new Set(Object.keys(JP_PREFECTURES))

/** Type-predicate for an ISO 3166-2:JP prefecture code (`"01"`..`"47"`). */
export function isJapanesePrefectureCode(input: unknown): input is JapanesePrefectureCode {
	return typeof input === "string" && PREFECTURE_CODE_SET.has(input)
}

/**
 * Fold a romaji surface form so `Tōkyō`, `Tokyo`, and `Tokyo-to` all key alike: strip macrons (NFD
 *
 * - Drop the combining marks), lowercase, peel off an appended `-to`/`-do`/`-fu`/`-ken` type-suffix,
 *   then drop everything but `a-z`. `Tōkyō-to` and `tokyo` both → `tokyo`.
 *
 * The suffix is only stripped when it is a genuine appendage — separated by a
 * hyphen/space/middle-dot (`Tokyo-to`, `Osaka fu`) or trailing the macron-bearing long-vowel form.
 * That guard is load-bearing: four bare romaji names already END in a suffix syllable (Kyo**to**,
 * Gi**fu**, Hokkai**do**, Kumamo**to**), and a blind trailing-strip would maim them. We never strip
 * from an unseparated bare name, so `kyoto` stays `kyoto`.
 */
function foldRomaji(s: string): string {
	const lowered = s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
	// Strip an appended type-suffix only when a separator (hyphen / space / middle dot) precedes it.
	const desuffixed = lowered.replace(/[-\s·][\s]*(to|do|fu|ken)$/, "")
	return desuffixed.replace(/[^a-z]/g, "")
}

/**
 * Strip the trailing 都/道/府/県 admin kanji from a prefecture name (`東京都` → `東京`). Hokkaido is the
 * exception: `北海道` ends in 道 but is a single indivisible name, so it is left whole.
 */
function stripKanjiSuffix(kanji: string): string {
	if (kanji === "北海道") return kanji
	return kanji.replace(/[都道府県]$/, "")
}

/**
 * Folded romaji / kanji surface form → ISO 3166-2:JP code. Every prefecture contributes several
 * keys: the macron-folded romaji (and the suffixed `name-ken` form folds to the same key), the full
 * kanji (`東京都`), and the suffix-less kanji (`東京`). Hokkaido keeps its 道 in both kanji keys.
 */
export const JP_PREFECTURE_NAME_TO_CODE: ReadonlyMap<string, JapanesePrefectureCode> = (() => {
	const out = new Map<string, JapanesePrefectureCode>()
	for (const code of Object.keys(JP_PREFECTURES) as JapanesePrefectureCode[]) {
		const info = JP_PREFECTURES[code]
		out.set(foldRomaji(info.romaji), code)
		out.set(info.kanji, code)
		out.set(stripKanjiSuffix(info.kanji), code)
	}
	return out
})()

/**
 * Resolve a Japanese prefecture surface form to its ISO 3166-2:JP code, accepting:
 *
 * - A code directly (`"13"` → `"13"`),
 * - A romaji name, case-insensitive, macrons optional, with OR without the romaji type-suffix
 *   (`Tōkyō` / `Tokyo` / `tokyo` / `Tokyo-to` → `"13"`),
 * - A kanji name, with or without its 都/道/府/県 suffix (`東京都` / `東京` → `"13"`).
 *
 * Returns null for anything it cannot place.
 */
export function lookupJapanesePrefecture(input: string | null | undefined): JapanesePrefectureCode | null {
	if (!input || typeof input !== "string") return null
	const trimmed = input.trim()
	if (PREFECTURE_CODE_SET.has(trimmed)) return trimmed as JapanesePrefectureCode
	// Try kanji first (exact, then suffix-less), then fall back to the macron-folded romaji.
	return JP_PREFECTURE_NAME_TO_CODE.get(trimmed) ?? JP_PREFECTURE_NAME_TO_CODE.get(foldRomaji(trimmed)) ?? null
}

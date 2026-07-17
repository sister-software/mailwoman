/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A faithful reimplementation of Python's `json.dumps` single-line serialization, used by the
 *   ported `scripts/eval/*.ts` golden/eval builders so their JSONL output is byte-identical to the
 *   Python originals (the committed `data/eval/**` files were written by `json.dumps`).
 *
 *   Two things `JSON.stringify` gets "wrong" relative to Python and that this fixes:
 *
 *   1. **Separators.** Python's default is `(", ", ": ")` — a space after every comma and colon.
 *        `JSON.stringify` is compact (`","` / `":"`). The committed files are spaced, so we match.
 *   2. **`ensure_ascii`.** Python defaults to escaping every non-ASCII codepoint as `\uXXXX` (surrogate
 *        pairs for astral chars). `JSON.stringify` emits raw UTF-8. We replicate Python's default
 *        (`ensureAscii: true`) and allow `ensure_ascii=False` (`ensureAscii: false`).
 *
 *   String escaping of ASCII (quote, backslash, `\n`/`\t`/`\r`/`\b`/`\f`, other control -> `\u00xx`)
 *   is identical between `JSON.stringify` and Python's json, so we delegate per-string base
 *   escaping to `JSON.stringify` and only post-escape the non-ASCII range when `ensureAscii` is
 *   on.
 *
 *   Caveat: JS has a single number type, so a whole-valued float (e.g. an exact `5.0` coordinate)
 *   serializes as `5`, whereas Python's `float(5.0)` -> `"5.0"`. Real-world lat/lon land on exact
 *   integers vanishingly rarely; the builders that emit coordinates accept this edge.
 */

export interface PyJSONOptions {
	/** Escape non-ASCII as `\uXXXX` (Python `ensure_ascii`). Defaults to `true`, matching Python. */
	ensureAscii?: boolean
}

/** Serialize one string the way Python's json does (then optionally `ensure_ascii`-escape it). */
function serializeString(value: string, ensureAscii: boolean): string {
	// JSON.stringify handles the quote/backslash/control escaping identically to Python's json.
	const out = JSON.stringify(value)

	if (!ensureAscii) return out
	// ensure_ascii: escape every code unit >= 0x80 as \uXXXX (surrogate halves handled per-unit,
	// exactly as CPython emits astral codepoints as a \u-pair).
	let escaped = ""

	for (let i = 0; i < out.length; i++) {
		const code = out.charCodeAt(i)
		escaped += code > 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : out[i]
	}

	return escaped
}

/** Serialize one finite/non-finite number the way Python's json does. */
function serializeNumber(value: number): string {
	if (Number.isFinite(value)) return JSON.stringify(value)

	// Python json renders these literally (not RFC-valid, but it's what json.dumps does by default).
	if (Number.isNaN(value)) return "NaN"

	return value > 0 ? "Infinity" : "-Infinity"
}

function serialize(value: unknown, ensureAscii: boolean): string {
	if (value === null || value === undefined) return "null"
	const t = typeof value

	if (t === "boolean") return value ? "true" : "false"

	if (t === "number") return serializeNumber(value as number)

	if (t === "string") return serializeString(value as string, ensureAscii)

	if (Array.isArray(value)) {
		return "[" + value.map((v) => serialize(v, ensureAscii)).join(", ") + "]"
	}

	if (t === "object") {
		const parts: string[] = []

		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v === undefined) continue // a key Python would never have produced
			parts.push(serializeString(k, ensureAscii) + ": " + serialize(v, ensureAscii))
		}

		return "{" + parts.join(", ") + "}"
	}
	throw new TypeError(`pyJSONDumps: unsupported value of type ${t}`)
}

/** `json.dumps(value)` — single line, `(", ", ": ")` separators, `ensure_ascii` per options. */
export function pyJSONDumps(value: unknown, options: PyJSONOptions = {}): string {
	return serialize(value, options.ensureAscii ?? true)
}

/**
 * Render a string->number map the way Python prints `dict(...)` / `dict(Counter(...))` — single-quoted keys, `, ` / `:
 * ` separators (e.g. `{'US': 1840, 'FR': 950}`). Insertion order is preserved.
 */
export function pyReprDict(entries: Iterable<readonly [string, number]>): string {
	const parts: string[] = []

	for (const [k, v] of entries) {
		parts.push(`'${k}': ${v}`)
	}

	return "{" + parts.join(", ") + "}"
}

import { stringifyJSON } from "#json"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A faithful reimplementation of Python's `json.dumps` single-line serialization, used by the
 *   ported `scripts/eval/*.ts` golden/eval builders so their jsonl output is byte-identical to the
 *   Python originals (the committed `data/eval/**` files were written by `json.dumps`).
 *
 *   Two things `JSON.stringify` gets "wrong" relative to Python and that this fixes:
 *
 *   1. **Separators.** Python's default is `(", ", ": ")` — a space after every comma and colon.
 *        `JSON.stringify` is compact (`","` / `":"`). The committed files are spaced, so we match.
 *   2. **`ensure_ascii`.** Python defaults to escaping every non-ascii codepoint as `\uXXXX` (surrogate
 *        pairs for astral chars). `JSON.stringify` emits raw UTF-8. We replicate Python's default
 *        (`ensureASCII: true`) and allow `ensure_ascii=False` (`ensureASCII: false`).
 *
 *   ASCII string escaping (quote, backslash, `\n`/`\t`/`\r`/`\b`/`\f`, other control -> `\u00xx`)
 *   is identical between `JSON.stringify` and Python's json, so we delegate per-string base
 *   escaping to `JSON.stringify` and only post-escape the non-ascii range when `ensureASCII` is
 *   on.
 *
 *   Caveat: JS has a single number type, so a whole-valued float (e.g. an exact `5.0` coordinate)
 *   serializes as `5`, whereas Python's `float(5.0)` -> `"5.0"`. Real-world lat/lon land on exact
 *   integers vanishingly rarely. the builders that emit coordinates accept this edge.
 */

/**
 * Serialize one string the way Python's json does (then optionally `ensure_ascii`-escape it).
 */
function serializeString(value: string, ensureASCII: boolean): string {
	// JSON.stringify handles the quote/backslash/control escaping identically to Python's json.
	const out = stringifyJSON(value)

	if (!ensureASCII) return out
	// ensure_ascii: escape every code unit >= 0x80 as \uXXXX
	// (surrogate halves handled per-unit, exactly as CPython emits astral codepoints as a \u-pair).
	let escaped = ""

	for (let i = 0; i < out.length; i++) {
		const code = out.charCodeAt(i)
		escaped += code > 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : out[i]
	}

	return escaped
}

/**
 * Serialize one finite/non-finite number the way Python's json does.
 */
function serializeNumber(value: number): string {
	if (Number.isFinite(value)) return stringifyJSON(value)

	// Python json renders these literally (not RFC-valid, but it's what json.dumps does by default).
	if (Number.isNaN(value)) return "NaN"

	return value > 0 ? "Infinity" : "-Infinity"
}

function serialize(value: unknown, ensureASCII: boolean): string {
	if (value === null || !value) return "null"
	const t = typeof value

	if (t === "boolean") return value ? "true" : "false"

	if (t === "number") return serializeNumber(value as number)

	if (t === "string") return serializeString(value as string, ensureASCII)

	if (Array.isArray(value)) {
		return "[" + value.map((v) => serialize(v, ensureASCII)).join(", ") + "]"
	}

	if (t === "object") {
		const parts: string[] = []

		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (!v) continue // a key Python would never have produced
			parts.push(serializeString(k, ensureASCII) + ": " + serialize(v, ensureASCII))
		}

		return "{" + parts.join(", ") + "}"
	}

	throw new TypeError(`pyJSONDumps: unsupported value of type ${t}`)
}

/**
 * `json.dumps(value)` — single line, `(", ", ": ")` separators, `ensure_ascii` per options.
 */
export interface PyJSONDumpOptions {
	ensureASCII?: boolean
}

/**
 * Serialize a value the way Python's json.dumps does.
 */
export function pyJSONDumps(value: unknown, options: PyJSONDumpOptions = {}): string {
	return serialize(value, options.ensureASCII ?? true)
}

/**
 * A number Python holds as a `float`, so {@linkcode pythonJSONDumps} writes it as
 * `repr(float)` writes it: `2.0` rather than `2`, `1e-05` rather than `0.00001`.
 *
 * A plain `number` is written as a Python `int`, and must then be an integer.
 */
export class PythonFloat {
	readonly value: number

	constructor(value: number) {
		this.value = value
	}
}

/**
 * Marks `value` as a Python `float`, keeping `null` as `null`.
 */
export function asPythonFloat(value: number): PythonFloat
export function asPythonFloat(value: number | null): PythonFloat | null

export function asPythonFloat(value: number | null): PythonFloat | null {
	return value == null ? null : new PythonFloat(value)
}

/**
 * The smallest decimal exponent `repr(float)` writes in fixed notation: CPython's
 * `float_repr_style` "short" switches to scientific notation below `1e-4`.
 */
const REPR_FIXED_MIN_EXPONENT = -4

/**
 * One past the largest decimal exponent `repr(float)` writes in fixed notation:
 * from `1e16` up it writes `1e+16`.
 */
const REPR_FIXED_MAX_EXPONENT = 16

/**
 * `repr(x)` of a Python float: the shortest round-trip digits, in scientific
 * notation below 1e-4 or from 1e16 up.
 */
export function pythonFloatRepr(x: number): string {
	if (Number.isNaN(x)) return "NaN"

	if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity"

	if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0"

	const [mantissa = "", exponentText = "0"] = x.toExponential().split("e")
	const exponent = Number(exponentText)
	const sign = mantissa.startsWith("-") ? "-" : ""
	const digits = mantissa.replace("-", "").replace(".", "")

	if (exponent < REPR_FIXED_MIN_EXPONENT || exponent >= REPR_FIXED_MAX_EXPONENT) {
		const lead = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits

		return `${sign}${lead}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`
	}

	if (exponent >= 0) {
		const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0")

		return `${sign}${whole}.${digits.slice(exponent + 1) || "0"}`
	}

	return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`
}

/**
 * Options for {@linkcode pythonJSONDumps}, named as `json.dumps` names them.
 */
export interface PythonJSONOptions {
	/**
	 * Spaces per nesting level.
	 * Unset writes one line with `", "` and `": "` separators.
	 */
	indent?: number
	sortKeys?: boolean
	/**
	 * @default true
	 */
	ensureASCII?: boolean
}

function pythonString(value: string, ensureASCII: boolean): string {
	// JSON.stringify escapes the quote, the backslash and the C0 controls as Python's json does.
	// Python's `ensure_ascii` also escapes DEL and every code unit above it, one `\uXXXX` per UTF-16 unit.
	const out = stringifyJSON(value)

	if (!ensureASCII) return out

	let escaped = ""

	for (let i = 0; i < out.length; i++) {
		const code = out.charCodeAt(i)

		escaped += code >= 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : out[i]
	}

	return escaped
}

function pythonValue(value: unknown, options: Required<PythonJSONOptions>, depth: number): string {
	if (value == null) return "null"

	if (value instanceof PythonFloat) return pythonFloatRepr(value.value)

	if (typeof value === "boolean") return value ? "true" : "false"

	if (typeof value === "bigint") return value.toString()

	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new TypeError(`pythonJSONDumps: ${value} is not an integer; mark a Python float with asPythonFloat`)
		}

		return Object.is(value, -0) ? "0" : String(value)
	}

	if (typeof value === "string") return pythonString(value, options.ensureASCII)

	const indented = options.indent >= 0
	const inner = indented ? "\n" + " ".repeat(options.indent * (depth + 1)) : ""
	const outer = indented ? "\n" + " ".repeat(options.indent * depth) : ""
	const separator = indented ? "," : ", "

	if (Array.isArray(value)) {
		if (!value.length) return "[]"

		const items = value.map((item) => pythonValue(item, options, depth + 1))

		return `[${inner}${items.join(separator + inner)}${outer}]`
	}

	if (value instanceof Map || typeof value === "object") {
		const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as Record<string, unknown>)

		if (!entries.length) return "{}"

		if (options.sortKeys) {
			entries.sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
		}

		const items = entries.map(
			([key, item]) => `${pythonString(String(key), options.ensureASCII)}: ${pythonValue(item, options, depth + 1)}`
		)

		return `{${inner}${items.join(separator + inner)}${outer}}`
	}

	throw new TypeError(`pythonJSONDumps: unsupported value of type ${typeof value}`)
}

/**
 * `json.dumps(value, indent=…, sort_keys=…, ensure_ascii=…)`, byte for byte.
 *
 * A `number` is a Python `int` and a {@linkcode PythonFloat} a Python `float`,
 * because JavaScript has one number type and Python writes `2.0` and `2` differently.
 * A `Map` keeps its insertion order, as a `dict` does.
 *
 * @throws When a plain `number` is not an integer.
 */
export function pythonJSONDumps(value: unknown, options: PythonJSONOptions = {}): string {
	return pythonValue(
		value,
		{
			indent: options.indent ?? -1,
			sortKeys: options.sortKeys ?? false,
			ensureASCII: options.ensureASCII ?? true,
		},
		0
	)
}

/**
 * Render a string->number map the way Python prints `dict(...)` / `dict(Counter(...))` —
 * single-quoted keys, `, ` / `: ` separators (e.g. `{'US': 1840, 'FR': 950}`).
 * Insertion order is preserved.
 */

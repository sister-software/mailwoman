/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser stand-in for `node:path`, wired as the webpack `fallback` in `plugin.ts`. The previous
 *   fallback was `false` (empty module), which works until client-reachable code uses a NAMED import
 *   — an ESM named import of a missing export is a hard compile error, not a runtime `undefined`.
 *   `path-ts`'s `path-builder.js` does `import { posix } from "@mailwoman/platform/path"`, and the demo's
 *   source-aliased `@mailwoman/*` graph pulls it into the client bundle (2026-08-05 build break).
 *
 *   Posix-only semantics on purpose: the browser has no platform paths, and every in-repo consumer
 *   (path-ts included) treats paths as URL-ish forward-slash strings. `resolve` roots at "/" —
 *   there is no cwd in a browser. Keep this file dependency-free and plain JS: it is bundled by
 *   webpack directly and must never pull Node built-ins.
 */

/**
 * Posix path separator — the only separator this shim speaks (see the @file block).
 */
export const sep = "/"

/**
 * Posix PATH-list delimiter, exported for interface completeness with node:path.
 */
export const delimiter = ":"

export function isAbsolute(p) {
	return p.startsWith("/")
}

function normalizeParts(parts, allowAboveRoot) {
	const out = []

	for (const part of parts) {
		if (!part || part === ".") continue

		if (part === "..") {
			if (out.length && out.at(-1) !== "..") {
				out.pop()
			} else if (allowAboveRoot) {
				out.push("..")
			}
		} else {
			out.push(part)
		}
	}

	return out
}

export function normalize(p) {
	if (!p.length) return "."
	const absolute = isAbsolute(p)
	const trailingSlash = p.endsWith("/")
	const normalized = normalizeParts(p.split("/"), !absolute).join("/")
	let result = normalized

	if (!result && !absolute) {
		result = "."
	}

	if (result && trailingSlash) {
		result += "/"
	}

	return absolute ? `/${result}` : result
}

export function join(...parts) {
	const joined = parts.filter((part) => Boolean(part?.length)).join("/")

	return joined.length ? normalize(joined) : "."
}

export function resolve(...parts) {
	let resolved = ""
	let absolute = false

	for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
		const part = parts[i]

		if (!part?.length) continue
		resolved = resolved.length ? `${part}/${resolved}` : part
		absolute = isAbsolute(part)
	}

	// No cwd in a browser: relative stacks root at "/".
	const result = normalizeParts(resolved.split("/"), false).join("/")

	return `/${result}`
}

export function dirname(p) {
	if (!p.length) return "."
	const trimmed = p.endsWith("/") ? p.slice(0, -1) : p
	const idx = trimmed.lastIndexOf("/")

	if (idx === -1) return "."

	if (idx === 0) return "/"

	return trimmed.slice(0, idx)
}

export function basename(p, suffix) {
	const trimmed = p.endsWith("/") ? p.slice(0, -1) : p
	const idx = trimmed.lastIndexOf("/")
	let base = idx === -1 ? trimmed : trimmed.slice(idx + 1)

	if (suffix && base.endsWith(suffix) && base !== suffix) {
		base = base.slice(0, -suffix.length)
	}

	return base
}

export function extname(p) {
	const base = basename(p)
	const idx = base.lastIndexOf(".")

	return idx <= 0 ? "" : base.slice(idx)
}

export function relative(from, to) {
	const fromParts = resolve(from).split("/").filter(Boolean)
	const toParts = resolve(to).split("/").filter(Boolean)
	let shared = 0

	while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
		shared++
	}

	const ups = fromParts.length - shared

	return [...Array.from({ length: ups }, () => ".."), ...toParts.slice(shared)].join("/")
}

export function parse(p) {
	const root = isAbsolute(p) ? "/" : ""
	const base = basename(p)
	const ext = extname(p)

	return { root, dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }
}

export function format(obj) {
	const dir = obj.dir ?? obj.root ?? ""
	const base = obj.base ?? `${obj.name ?? ""}${obj.ext ?? ""}`

	return dir && dir !== "/" ? `${dir}/${base}` : `${dir}${base}`
}

const shim = {
	sep,
	delimiter,
	isAbsolute,
	normalize,
	join,
	resolve,
	dirname,
	basename,
	extname,
	relative,
	parse,
	format,
}

/**
 * `posix` points back at the same object, exactly as node:path's posix does on a posix platform — this named export is
 * the one whose absence broke the client compile.
 */
export const posix = shim
shim.posix = shim
export default shim

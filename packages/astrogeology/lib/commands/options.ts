/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The option readers the four commands share. A plain module, because a command module is TSX and Node loads a
 *   command only compiled; nothing a command imports may be another command.
 */

import { CommandError } from "@mailwoman/core/scripting/command"

import { BODIES, type BuildableBodyID } from "#bodies"

/**
 * The body a `--body` value names, or a usage error.
 */
export function parseBody(value: string): BuildableBodyID {
	if (value in BODIES) return value as BuildableBodyID

	throw new CommandError(`--body must be one of ${Object.keys(BODIES).join(", ")}, got ${JSON.stringify(value)}`)
}

/**
 * The zoom a `--max-zoom` value names, or a usage error.
 */
export function parseMaxZoom(value: string): number {
	const zoom = Number(value)

	if (!Number.isInteger(zoom) || zoom < 0) {
		throw new CommandError(`--max-zoom must be a non-negative integer, got ${value}`)
	}

	return zoom
}

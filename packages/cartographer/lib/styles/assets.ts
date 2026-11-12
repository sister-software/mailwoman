// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The hosted glyph and sprite assets a Protomaps style reads, mirrored under the
 *   public bucket so a style never depends on an upstream host at render time.
 */

/**
 * The glyph host every style composed here reads fonts from.
 *
 * The Protomaps font set, mirrored under the public bucket.
 * The stacks it serves are listed in `#styles/fonts`.
 */
export const PROTOMAPS_GLYPHS_URL = "https://public.mailwoman.post/protomaps/fonts/{fontstack}/{range}.pbf"

/**
 * The Protomaps sprite sheets the mirror serves, one per stock flavor.
 */
export const PROTOMAPS_SPRITE_NAMES = ["light", "dark", "white", "grayscale", "black"] as const

export type ProtomapsSpriteName = (typeof PROTOMAPS_SPRITE_NAMES)[number]

/**
 * The URL of a mirrored v4 sprite sheet, without the `.json` or `.png` suffix MapLibre appends.
 *
 * The sprite must match the basemap schema version: the v4 sprite includes the icons the v4 theme's
 * layers reference by name, so a style over a different basemap version needs a different sprite.
 */
export function protomapsSpriteURL(name: ProtomapsSpriteName): string {
	return `https://public.mailwoman.post/protomaps/sprites/v4/${name}`
}

/**
 * The Earth sprite.
 */
export const PROTOMAPS_SPRITE_URL = protomapsSpriteURL("light")

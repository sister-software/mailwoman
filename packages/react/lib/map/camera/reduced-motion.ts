// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Whether the viewer asked for reduced motion.
 * A camera move then jumps instead of flying.
 *
 * Answers false where `matchMedia` doesn't exist, so a test environment without
 * a window gets the animated default.
 */
export function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

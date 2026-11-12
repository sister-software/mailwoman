// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A complete {@link EngineRegistryLike} for tests, with the one or two members a case cares about overridden
 *   and `acquire` throwing unless a case passed an engine.
 */

import type { GeocodeSession } from "mailwoman/geocode"

import type { EffectiveConfig, EngineLease, EngineRegistryLike } from "#dev-mcp/engine/registry"
import type { TreeFingerprint } from "#dev-mcp/tree-fingerprint"

/**
 * A fingerprint that never changes, so a test asserting on staleness controls it rather than the clock.
 */
const STUB_FINGERPRINT: TreeFingerprint = {
	digest: "tree0",
	gitHead: "head0",
	dirtyFiles: [],
	newestMtimeMs: 0,
	newestPath: null,
	filesWalked: 1,
}

/**
 * Build a registry double.
 * Pass only the members the case under test reads.
 */
export function stubEngineRegistry(overrides: Partial<EngineRegistryLike> = {}): EngineRegistryLike {
	return {
		repoRoot: "/tmp/stub",
		maxResident: 2,
		size: 1,
		bootFingerprint: STUB_FINGERPRINT,
		sourceMoved: async () => false,
		fingerprint: async () => STUB_FINGERPRINT,
		acquire: () => {
			throw new Error("stubEngineRegistry: this case was not given an engine to acquire")
		},
		summaries: () => [],
		evict: async () => true,
		evictAll: async () => 0,
		...overrides,
	}
}

/**
 * Build an engine double: pass the session behavior the case reads, while `session`
 * is asserted rather than completed because `GeocodeSession` is the real pipeline's
 * surface, far wider than any test drives.
 *
 * The double is a lease with an empty release, so `acquire` can return it as is.
 */
export function stubEngine(overrides: StubEngineOverrides): EngineLease {
	return {
		[Symbol.dispose]: () => {},
		engineID: overrides.engineID ?? "stub",
		effective: { ...overrides.effective } as EffectiveConfig,
		fingerprint: { ...STUB_FINGERPRINT, ...overrides.fingerprint },
		buildMs: overrides.buildMs ?? 1,
		lastUsed: overrides.lastUsed ?? 0,
		uses: overrides.uses ?? 1,
		session: overrides.session as GeocodeSession,
		lexicons: [],
	}
}

/**
 * What a case may set on {@link stubEngine}; `session` is required because a
 * tool that acquires an engine always reaches it.
 *
 * A default one would answer every query with the same silence.
 */
export interface StubEngineOverrides {
	/**
	 * The session behavior this case drives, asserted to `GeocodeSession` inside {@link stubEngine};
	 * `unknown` rather than `Partial<GeocodeSession>` because a partial checks each member it includes
	 * against the real signature and every case here returns a trimmed geocode result on purpose.
	 */
	session: unknown
	engineID?: string
	effective?: Partial<EffectiveConfig>
	fingerprint?: Partial<TreeFingerprint>
	buildMs?: number
	lastUsed?: number
	uses?: number
}

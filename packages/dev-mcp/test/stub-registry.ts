/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A complete {@link EngineRegistryLike} for tests, with the one or two members a case cares about overridden
 *   and `acquire` throwing unless a case passed an engine.
 */

import type { EffectiveConfig, Engine, EngineRegistryLike } from "@mailwoman/dev-mcp/engine/registry"
import type { TreeFingerprint } from "@mailwoman/dev-mcp/tree-fingerprint"
import type { GeocodeSession } from "mailwoman/geocode"

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
 * Build a registry double; pass only the members the case under test actually reads.
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
		evict: () => true,
		evictAll: () => 0,
		...overrides,
	}
}

/**
 * Build an engine double: pass the session behaviour the case reads,
 * while `session` is asserted rather than completed because `GeocodeSession` is the
 * real pipeline's surface, far wider than any test drives.
 */
export function stubEngine(overrides: StubEngineOverrides): Engine {
	return {
		engineID: overrides.engineID ?? "stub",
		effective: { ...overrides.effective } as EffectiveConfig,
		fingerprint: { ...STUB_FINGERPRINT, ...overrides.fingerprint },
		buildMs: overrides.buildMs ?? 1,
		lastUsed: overrides.lastUsed ?? 0,
		uses: overrides.uses ?? 1,
		session: overrides.session as GeocodeSession,
	}
}

/**
 * What a case may set on {@link stubEngine}; `session` is required because a tool that acquires
 * an engine always reaches it, and a default one would answer every query with the same silence.
 */
export interface StubEngineOverrides {
	/**
	 * The session behaviour this case drives, asserted to `GeocodeSession`
	 * inside {@link stubEngine}; `unknown` rather than `Partial<GeocodeSession>`
	 * because a partial checks each member it does carry against the real signature
	 * and every case here returns a trimmed geocode result on purpose.
	 */
	session: unknown
	engineID?: string
	effective?: Partial<EffectiveConfig>
	fingerprint?: Partial<TreeFingerprint>
	buildMs?: number
	lastUsed?: number
	uses?: number
}

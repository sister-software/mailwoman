/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A complete {@link EngineRegistryLike} for tests, with the one or two members a case cares about overridden.
 *
 *   Every tool in this package takes the registry, and almost every test of one needs a registry that does nothing.
 *   Written inline, that stub is an object literal missing most of the interface, which only compiles by asserting —
 *   and an assertion keeps compiling after a method is renamed or its signature changes, so the stub quietly stops
 *   standing for the thing it doubles. Built here instead, a change to `EngineRegistryLike` fails in ONE place with
 *   the name of the member that moved.
 *
 *   `acquire` throws by default. A test that needs an engine says so by passing one; a test that reaches the engine
 *   without meaning to gets a message rather than a `undefined` it will misread.
 */

import type { GeocodeSession } from "mailwoman/geocode-session"

import type { EffectiveConfig, Engine, EngineRegistryLike } from "#engine-registry"
import type { TreeFingerprint } from "#tree-fingerprint"

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
 * Build a registry double. Pass only the members the case under test actually reads.
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
 * Build an engine double. Pass the session behaviour the case reads; everything else is filled in.
 *
 * `session` is asserted rather than completed on purpose, and it is the ONLY assertion here: `GeocodeSession` is the
 * real pipeline's surface, far wider than any test drives, while the seven members of `Engine` around it are cheap to
 * state and are what a tool reads when it reports which engine answered.
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
 * What a case may set on {@link stubEngine}. `session` is required because a tool that acquires an engine always reaches
 * it, and a default one would answer every query with the same silence.
 */
export interface StubEngineOverrides {
	/**
	 * The session behaviour this case drives, asserted to `GeocodeSession` inside {@link stubEngine}.
	 *
	 * `unknown` rather than `Partial<GeocodeSession>`: a partial checks each member it DOES carry against the real
	 * signature, and every case here returns a trimmed geocode result on purpose, so the partial rejects them all. One
	 * documented assertion in one place is what this file buys — the eight it replaces each asserted the whole registry,
	 * so a renamed registry method went unnoticed in all of them.
	 */
	session: unknown
	engineID?: string
	effective?: Partial<EffectiveConfig>
	fingerprint?: Partial<TreeFingerprint>
	buildMs?: number
	lastUsed?: number
	uses?: number
}

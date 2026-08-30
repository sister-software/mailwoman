/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Scratch directories that remove themselves.
 *
 *   Rooted at `$MAILWOMAN_TEMP_ROOT` rather than the operating system's `tmpdir()`, which is why this lives in
 *   `@mailwoman/core` and not in `@mailwoman/platform`: the root comes from the typed public environment, and
 *   `@mailwoman/platform` sits below that and has no dependencies.
 */

import { mkdtempDisposable } from "@mailwoman/platform/fs/promises"
import { join } from "@mailwoman/platform/path"

import { makeDirectories } from "#fs/writers"

import { tempRootPath } from "../utils/data-root.ts"

/**
 * A temporary directory that removes itself when the owning scope ends, together with everything registered on it.
 *
 * ```ts
 * await using scratch = await temporaryDirectory("filer-build-")
 * const out = scratch.resolve("filer.db")
 * ```
 *
 * {@linkcode move} answers this same shape rather than a bare `AsyncDisposableStack`, which is what a factory needs:
 * the stack's own `move()` drops `path`, so every caller would rebuild it by hand afterwards. {@linkcode moveWith} does
 * that transfer and attaches what the caller asked for, so a fixture builder is one statement.
 */
export interface TemporaryDirectory extends AsyncDisposable {
	/**
	 * The directory itself.
	 */
	readonly path: string
	/**
	 * A path inside the directory.
	 */
	resolve(...segments: string[]): string
	/**
	 * Take ownership of a resource. It is released before the directory is removed, so a database opened on a file in
	 * here is closed while the file still exists.
	 */
	use<T extends AsyncDisposable | Disposable | null | undefined>(resource: T): T
	/**
	 * Hand the directory and everything registered on it to a scope that outlives this one. This binding disposes nothing
	 * afterwards.
	 */
	move(): TemporaryDirectory
	/**
	 * {@linkcode move}, carrying `extras` alongside — the shape a fixture builder returns.
	 */
	moveWith<T extends object>(extras: T): TemporaryDirectory & T
}

function asTemporaryDirectory(path: string, resources: AsyncDisposableStack): TemporaryDirectory {
	return {
		path,
		resolve: (...segments: string[]) => join(path, ...segments),
		use: (resource) => resources.use(resource),
		move: () => asTemporaryDirectory(path, resources.move()),
		moveWith: (extras) => Object.assign(asTemporaryDirectory(path, resources.move()), extras),
		[Symbol.asyncDispose]: () => resources.disposeAsync(),
	}
}

/**
 * Create a new temporary directory under `$MAILWOMAN_TEMP_ROOT`, removed when the owning scope ends.
 *
 * The root is created if it does not exist: `mkdtemp` fails on a missing parent, and a configured root that nothing has
 * written to yet is the normal state on a fresh machine.
 */
export async function temporaryDirectory(prefix = "mailwoman-"): Promise<TemporaryDirectory> {
	const root = tempRootPath()

	await makeDirectories(root)

	const resources = new AsyncDisposableStack()
	const directory = resources.use(await mkdtempDisposable(join(root, prefix)))

	return asTemporaryDirectory(directory.path, resources)
}

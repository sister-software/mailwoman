/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Scratch directories that remove themselves.
 *
 *   Rooted at `$MAILWOMAN_TEMP_ROOT` rather than the operating system's `tmpdir()`, which is why this lives in
 *   `@mailwoman/core`: the root comes from the typed public environment.
 */

import { mkdtempDisposable } from "node:fs/promises"
import { join } from "node:path"

import { PathBuilder, resolvePath, type PathBuilderLike } from "path-ts"

import { makeDirectories } from "#fs/writers"
import { tempRootPath } from "#utils/data-root"

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
	readonly path: PathBuilder
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

function asTemporaryDirectory(_path: PathBuilderLike, resources: AsyncDisposableStack): TemporaryDirectory {
	const pathBuilder = PathBuilder.from(_path)

	return {
		path: pathBuilder,
		resolve: (...segments: PathBuilderLike[]) =>
			resolvePath(pathBuilder, ...segments.map((segment) => segment.toString())),
		use: (resource) => resources.use(resource),
		move: () => asTemporaryDirectory(pathBuilder, resources.move()),
		moveWith: (extras) => Object.assign(asTemporaryDirectory(pathBuilder, resources.move()), extras),
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

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The bytes a bare import of each compiled module keeps, per workspace.
 *
 *   Each workspace's `out/` modules are bundled as bare imports in one esbuild build, minified, with every module
 *   treated as effectful, pure annotations honored and legal comments dropped. Third-party packages, Node builtins and
 *   `.wasm`, `.css` and `.node` files stay external. A module that keeps bytes holds a statement esbuild cannot prove
 *   pure. That is where a `/* @__PURE__ *\/` annotation or a `sideEffects` declaration would let a bundler drop it.
 *
 *   The report sets no exit status. The `side-effects` check decides whether a declaration is true.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { build, type Plugin } from "esbuild"
import { resolvePath, resolvePathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * One workspace's row: its declaration and the modules whose bare import keeps bytes.
 */
export interface ImportSizeRow {
	workspace: string
	directory: string
	/**
	 * The workspace's `sideEffects` field, or `null` when it sets none.
	 */
	sideEffects: boolean | readonly string[] | null
	modules: number
	keptBytes: number
	kept: Array<{ file: string; bytes: number }>
	/**
	 * The build's first error, when the bundle failed and the row has no sizes.
	 */
	error: string | null
}

const BARE_ENTRY = "bare:"

/**
 * Resolves each `bare:` entry to a module that only imports its file, keeps every other
 * module's own statements by marking it effectful, and leaves third-party packages,
 * builtins and binary assets external.
 */
function bareImports(repoRoot: string): Plugin {
	return {
		name: "import-sizes",
		setup(builder) {
			// Esbuild compiles each filter as a Go regular expression. Go regular expressions have no `u` flag.
			// oxlint-disable-next-line unicorn/require-unicode-regexp -- Go regexp syntax
			builder.onResolve({ filter: /^bare:/ }, (args) => ({
				path: args.path.slice(BARE_ENTRY.length),
				namespace: "bare",
			}))

			// oxlint-disable-next-line unicorn/require-unicode-regexp -- Go regexp syntax
			builder.onLoad({ filter: /.*/, namespace: "bare" }, (args) => ({
				contents: `import ${stringifyJSON(args.path)}`,
				resolveDir: repoRoot,
				loader: "js",
			}))

			// oxlint-disable-next-line unicorn/require-unicode-regexp -- Go regexp syntax
			builder.onResolve({ filter: /.*/ }, async (args) => {
				if (args.pluginData === "inner") return null

				const relative = args.path.startsWith(".") || args.path.startsWith("/") || args.path.startsWith("#")

				const ours =
					args.path === "mailwoman" || args.path.startsWith("mailwoman/") || args.path.startsWith("@mailwoman/")

				if ((!relative && !ours) || /\.(?:wasm|css|node)$/u.test(args.path)) return { path: args.path, external: true }

				const resolved = await builder.resolve(args.path, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: "inner",
				})

				if (resolved.errors.length) return { errors: resolved.errors }

				return { path: resolved.path, external: resolved.external, sideEffects: true }
			})
		},
	}
}

async function sizeWorkspace(repoRoot: string, directory: string): Promise<ImportSizeRow | null> {
	const root = resolvePathBuilder(repoRoot, directory)

	if (!(await pathExists(root("out")))) return null

	const manifest = (await readPackageJSON(root("package.json"))) as {
		name?: string
		sideEffects?: boolean | readonly string[]
	}

	const files = await Array.fromAsync(Globerator.from("out/**/*.js", { cwd: root.toString(), absolute: true }))

	const row: ImportSizeRow = {
		workspace: manifest.name ?? directory,
		directory,
		sideEffects: manifest.sideEffects ?? null,
		modules: files.length,
		keptBytes: 0,
		kept: [],
		error: null,
	}

	if (!files.length) return row

	try {
		const result = await build({
			entryPoints: files.map((file) => `${BARE_ENTRY}${file}`),
			bundle: true,
			format: "esm",
			platform: "neutral",
			outdir: "import-sizes",
			legalComments: "none",
			minify: true,
			write: false,
			metafile: true,
			logLevel: "silent",
			plugins: [bareImports(repoRoot)],
		})

		const kept = new Map<string, number>()

		for (const output of Object.values(result.metafile.outputs)) {
			for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
				if (bytesInOutput > 0 && input.startsWith(`${directory}/`)) {
					kept.set(input, Math.max(kept.get(input) ?? 0, bytesInOutput))
				}
			}
		}

		row.kept = [...kept].map(([file, bytes]) => ({ file, bytes })).toSorted((a, b) => b.bytes - a.bytes)
		row.keptBytes = row.kept.reduce((sum, entry) => sum + entry.bytes, 0)
	} catch (error) {
		const failure = error as { errors?: Array<{ text: string }> }

		row.error = failure.errors?.[0]?.text ?? String(error)
	}

	return row
}

/**
 * The path `mwops side-effects` writes its rows to.
 */
export function importSizesPath(repoRoot: string): string {
	return resolvePath(repoRoot, "out", "repo-health", "effects", "import-sizes.json").toString()
}

/**
 * Sizes every compiled workspace and writes the rows to {@linkcode importSizesPath}.
 */
export async function writeImportSizes(repoRoot: string): Promise<ImportSizeRow[]> {
	const rows: ImportSizeRow[] = []

	for (const directory of await readWorkspaceDirectories(repoRoot)) {
		const row = await sizeWorkspace(repoRoot, directory)

		if (row) {
			rows.push(row)
		}
	}

	rows.sort((a, b) => b.keptBytes - a.keptBytes)

	await writeLocalJSONFile(rows, importSizesPath(repoRoot))

	return rows
}

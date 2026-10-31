/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Installs the libtorch the trainer crates link: the `libtorch-shared-with-deps` archive of the version and
 *   sha256 `launch/image.ts` pins, unpacked to `<out>/libtorch`.
 *
 *   The default `--out` is the repository's git-ignored `.cache`, where the root `.cargo/config.toml` points
 *   `LIBTORCH`, so `cargo build --workspace` and `cargo test -p trainer-loop` find it with no variable set.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/libtorch.run.ts [--variant cpu | cu130] [--out <dir>]
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, removePathIfPresent, writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import {
	LIBTORCH_ARCHIVE_SHA256,
	LIBTORCH_VERSION,
	libtorchArchiveURL,
	TrainerVariant,
} from "#tools/training/launch/image"

const { values } = parseArguments({
	options: {
		variant: { type: "string", default: TrainerVariant.CPU },
		out: { type: "string" },
	},
})

const variant = values.variant as TrainerVariant

if (!Object.values(TrainerVariant).includes(variant)) {
	throw new Error(`--variant must be one of ${Object.values(TrainerVariant).join(", ")}, not ${values.variant}`)
}

const out = values.out ? resolvePath(values.out).toString() : repoRootPath(".cache").toString()
const installed = resolvePath(out, "libtorch").toString()
const stamp = resolvePath(installed, `.mailwoman-${LIBTORCH_VERSION}-${variant}`).toString()

if (await pathExists(stamp)) {
	console.log(`${installed}: libtorch ${LIBTORCH_VERSION}+${variant} already installed`)
} else {
	const url = libtorchArchiveURL(variant)
	const response = await fetch(url)

	if (!response.ok) throw new Error(`${url} answered ${response.status}`)

	const bytes = new Uint8Array(await response.arrayBuffer())
	const digest = sha256Hex(bytes)

	if (digest !== LIBTORCH_ARCHIVE_SHA256[variant]) {
		throw new Error(`${url} has sha256 ${digest}, and image.ts pins ${LIBTORCH_ARCHIVE_SHA256[variant]}`)
	}

	const archive = resolvePath(out, `libtorch-${LIBTORCH_VERSION}-${variant}.zip`).toString()

	await makeDirectories(out)
	await removePathIfPresent(installed)
	await writeLocalBuffer(bytes, archive)
	await runFile("unzip", ["-q", archive, "-d", out])
	await removePathIfPresent(archive)
	await writeLocalBuffer(new Uint8Array(), stamp)

	console.log(`${installed}: libtorch ${LIBTORCH_VERSION}+${variant} (${bytes.length} bytes, sha256 ${digest})`)
}

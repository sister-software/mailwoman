/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The images a training sandbox runs: the Rust `trainer` binary linked against libtorch, for the CPU and for CUDA.
 *
 *   An image is built in two parts. The base layers ({@linkcode trainerBaseCommands}) download the libtorch archive at its
 *   pinned sha256 and install the Rust toolchain the root `rust-toolchain.toml` names. A build sandbox on that
 *   base then receives a tarball of {@linkcode trainerSourceBundle}'s files on stdin and runs {@linkcode trainerBuildScript}, and
 *   its filesystem snapshot is the training image. The JavaScript SDK copies no local files into an image, so the
 *   sources travel this way. The snapshot is published under {@linkcode trainerImageName}, which hashes every file the
 *   bundle holds, so a later launch with the same sources reuses it.
 */

import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workingTreeFiles } from "@mailwoman/core/git"
import { sha256Hex } from "@mailwoman/core/hash"
import { repoRootPath } from "@mailwoman/core/paths"

/**
 * The libtorch version `tch` 0.26.0 links (`torch-sys`'s `TORCH_VERSION`).
 */
export const LIBTORCH_VERSION = "2.13.0"

/**
 * A trainer image's libtorch build.
 */
export const TrainerVariant = {
	CPU: "cpu",
	/**
	 * CUDA 13.0, the line Modal's host driver serves to an A100.
	 */
	CUDA: "cu130",
} as const

export type TrainerVariant = (typeof TrainerVariant)[keyof typeof TrainerVariant]

/**
 * The sha256 of each `libtorch-shared-with-deps-2.13.0+<variant>.zip`.
 *
 * The CPU digest is also CI's cache key in `.github/workflows/test.yml`.
 */
export const LIBTORCH_ARCHIVE_SHA256: Readonly<Record<TrainerVariant, string>> = {
	cpu: "edbf4cbed78433d803e90a65f1752e57783d164bce66c95c0872b2ab8f5c159e",
	cu130: "945c5a3d946a28b387ad9dc9fddda7ba03e35fae1375b84ebff15df789436f82",
}

/**
 * The CUDA libraries libtorch 2.13.0+cu130 loads, which its archive does not hold:
 * the `Requires-Dist` set of the `torch-2.13.0+cu130` manylinux wheel.
 *
 * The CUDA image installs them with pip into the base image's interpreter,
 * the install the Python launcher's image ran on Modal.
 * The interpreter only installs the wheels, and the image runs no repository Python.
 */
export const CUDA_RUNTIME_WHEELS = [
	"cuda-toolkit[cublas,cudart,cufft,cufile,cupti,curand,cusolver,cusparse,nvjitlink,nvrtc,nvtx]==13.0.3",
	"nvidia-cudnn-cu13==9.20.0.48",
	"nvidia-cusparselt-cu13==0.8.1",
	"nvidia-nccl-cu13==2.29.7",
	"nvidia-nvshmem-cu13==3.4.5",
] as const

/**
 * The registry image each variant starts from.
 */
export const TRAINER_BASE_IMAGES: Readonly<Record<TrainerVariant, string>> = {
	cpu: "debian:bookworm-slim",
	cu130: "python:3.12-slim-bookworm",
}

/**
 * Where an image holds the repository files the trainer reads.
 * The binary reads them from `MAILWOMAN_REPO_ROOT`.
 */
export const TRAINER_REPO_ROOT = "/repo"

/**
 * The data file `DataFiles::in_repository` (`trainer-loop/src/config.rs`) reads
 * outside `packages/trainer`, relative to the root.
 *
 * The others sit under `packages/trainer/data`, which the bundle already holds.
 */
export const TRAINER_DATA_FILES = ["packages/neural/data/label-schema.v1.json"] as const

/**
 * The channel the root `rust-toolchain.toml` pins.
 *
 * @throws When the file states no channel.
 */
export async function trainerRustToolchain(): Promise<string> {
	const path = repoRootPath("rust-toolchain.toml")
	const channel = /^channel\s*=\s*"([^"]+)"/m.exec(await readLocalTextFile(path))?.[1]

	if (!channel) throw new Error(`${path} states no toolchain channel`)

	return channel
}

/**
 * The environment every trainer image sets.
 */
export const TRAINER_IMAGE_ENV: Readonly<Record<string, string>> = {
	PATH: "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	LIBTORCH: "/opt/libtorch",
	LD_LIBRARY_PATH: "/opt/libtorch/lib",
	MAILWOMAN_REPO_ROOT: TRAINER_REPO_ROOT,
}

/**
 * The base layers of a trainer image: build tools, libtorch at its pinned digest,
 * the CUDA wheels for the CUDA variant, and the Rust toolchain.
 */
export function trainerBaseCommands(variant: TrainerVariant, toolchain: string): string[] {
	const archive = `libtorch-shared-with-deps-${LIBTORCH_VERSION}%2B${variant}.zip`

	const commands = [
		"RUN apt-get update && apt-get install -y --no-install-recommends build-essential binutils ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*",
		`RUN curl -fsSL -o /tmp/libtorch.zip https://download.pytorch.org/libtorch/${variant}/${archive}`,
		`RUN echo '${LIBTORCH_ARCHIVE_SHA256[variant]}  /tmp/libtorch.zip' | sha256sum -c - && unzip -q /tmp/libtorch.zip -d /opt && rm /tmp/libtorch.zip`,
	]

	if (variant === TrainerVariant.CUDA) {
		commands.push(
			`RUN pip install --no-cache-dir ${CUDA_RUNTIME_WHEELS.map((wheel) => `'${wheel}'`).join(" ")}`,
			// Each wheel puts its libraries under `site-packages/nvidia/.../lib`; the loader learns every such directory.
			`RUN find "$(python -c 'import site; print(site.getsitepackages()[0])')/nvidia" -name 'lib*.so*' -printf '%h\\n' | sort -u > /etc/ld.so.conf.d/nvidia.conf && ldconfig`
		)
	}

	commands.push(
		`RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${toolchain}`,
		...Object.entries(TRAINER_IMAGE_ENV).map(([name, value]) => `ENV ${name}=${value}`)
	)

	return commands
}

/**
 * The script a build sandbox runs: unpack the bundle from stdin, build `trainer-cli`,
 * install it, and refuse a binary whose shared objects do not resolve.
 *
 * A CUDA binary must list `libtorch_cuda.so` as NEEDED, or libtorch never loads its
 * CUDA backend and the trainer picks the CPU on a GPU host.
 * The CUDA driver's `libcuda.so.1` is the one library a build sandbox lacks.
 * Modal mounts it into a GPU sandbox.
 */
export function trainerBuildScript(variant: TrainerVariant): string {
	const linkage =
		variant === TrainerVariant.CUDA
			? "readelf -d /usr/local/bin/trainer | grep -q 'libtorch_cuda\\.so'"
			: "trainer device --device cpu"

	return [
		"set -euo pipefail",
		`mkdir -p ${TRAINER_REPO_ROOT}`,
		`base64 -d | tar -xz -C ${TRAINER_REPO_ROOT}`,
		`cd ${TRAINER_REPO_ROOT}`,
		"cargo build --profile trainer --locked -p trainer-cli",
		`install -m 0755 ${TRAINER_REPO_ROOT}/target/trainer/trainer /usr/local/bin/trainer`,
		`rm -rf ${TRAINER_REPO_ROOT}/target /root/.cargo/registry`,
		"! ldd /usr/local/bin/trainer | grep 'not found' | grep -v 'libcuda\\.so\\.1'",
		linkage,
		"du -sxm / /opt/libtorch 2>/dev/null || true",
	].join("\n")
}

/**
 * The repository files a trainer image holds, relative to the repository root and sorted.
 *
 * Every file Git includes under `packages/trainer` except its Markdown, the mtf crates the trainer
 * depends on, the root workspace's manifest, lockfile and toolchain file, and the data files.
 */
export async function trainerSourceFiles(): Promise<string[]> {
	const trainer = await workingTreeFiles(["packages/trainer"])

	const mtf = await workingTreeFiles(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "packages/mtf/crates"])

	return [...new Set([...trainer.filter((path) => !path.endsWith(".md")), ...mtf, ...TRAINER_DATA_FILES])].toSorted()
}

/**
 * The bundle of trainer sources, and a digest over every path and its content.
 */
export interface TrainerSourceBundle {
	files: string[]
	digest: string
}

/**
 * Lists the trainer sources and hashes them, path and content, in sorted order.
 */
export async function trainerSourceBundle(): Promise<TrainerSourceBundle> {
	const files = await trainerSourceFiles()
	const entries: string[] = []

	for (const file of files) {
		entries.push(`${file}\u0000${sha256Hex(await readLocalBuffer(repoRootPath(file)))}`)
	}

	return { files, digest: sha256Hex(entries.join("\n")) }
}

/**
 * The published name of the trainer image for one variant, toolchain and source digest.
 */
export function trainerImageName(variant: TrainerVariant, toolchain: string, digest: string): string {
	return `mailwoman-trainer-${variant}-${toolchain}-${digest.slice(0, 16)}`
}

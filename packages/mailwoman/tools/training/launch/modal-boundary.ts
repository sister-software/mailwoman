/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Modal SDK behind {@linkcode ModalBoundary}. Credentials come from `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` or
 *   the active profile in `~/.modal.toml`, as the SDK reads them.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { AlreadyExistsError, type App, type Image, ModalClient, NotFoundError, type Secret, type Volume } from "modal"
import { dirname, resolvePath } from "path-ts"

import {
	type ModalBoundary,
	type OneShotSandboxSpec,
	SandboxNameTakenError,
	type SandboxState,
	type TrainerImageBuild,
	type TrainingSandboxSpec,
} from "#tools/training/launch/boundary"

/**
 * How long a trainer image build may run: the libtorch download, the CUDA wheels
 * and a release build of the trainer.
 */
const IMAGE_BUILD_TIMEOUT_MS = 60 * 60 * 1000

/**
 * How long the snapshot of a built trainer filesystem may take.
 */
const SNAPSHOT_TIMEOUT_MS = 10 * 60 * 1000

export interface ModalBoundaryOptions {
	appName: string
	volumeName: string
	mount: string
	/**
	 * A secret identifier passed to every training sandbox when configured.
	 */
	secretName?: string
	log: (line: string) => void
}

/**
 * The launcher's Modal calls over one client, app and volume.
 */
export class SDKModalBoundary implements ModalBoundary {
	readonly #client = new ModalClient()
	readonly #options: ModalBoundaryOptions
	#app: Promise<App> | null = null
	#volume: Promise<Volume> | null = null
	#secret: Promise<Secret> | null = null

	constructor(options: ModalBoundaryOptions) {
		this.#options = options
	}

	#appHandle(): Promise<App> {
		const app = this.#app ?? this.#client.apps.fromName(this.#options.appName, { createIfMissing: true })

		this.#app = app

		return app
	}

	#volumeHandle(): Promise<Volume> {
		const volume = this.#volume ?? this.#client.volumes.fromName(this.#options.volumeName)

		this.#volume = volume

		return volume
	}

	async ensureTrainerImage(build: TrainerImageBuild): Promise<string> {
		try {
			const published = await this.#client.images.fromName(build.name)

			this.#options.log(`Trainer image: ${build.name} (published, ${published.imageId})`)

			return published.imageId
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error
		}

		this.#options.log(`Trainer image: building ${build.name}`)

		const app = await this.#appHandle()

		const base: Image = await this.#client.images
			.fromRegistry(build.baseImage)
			.dockerfileCommands(build.baseCommands)
			.build(app)

		const sandbox = await this.#client.sandboxes.create(app, base, {
			cpu: 8,
			memoryMiB: 16_384,
			timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
			tags: { "mailwoman-image-build": build.name },
		})

		try {
			const process = await sandbox.exec(["bash", "-c", build.buildScript], { stdout: "pipe", stderr: "pipe" })

			await process.stdin.writeText(Buffer.from(build.bundle).toString("base64"))
			await process.stdin.close()

			const [stdout, stderr, code] = await Promise.all([
				process.stdout.readText(),
				process.stderr.readText(),
				process.wait(),
			])

			this.#options.log(stdout.trimEnd())

			if (code !== 0) throw new Error(`the trainer image build exited ${code}:\n${stderr.trimEnd()}`)

			const image = await sandbox.snapshotFilesystem({ timeoutMs: SNAPSHOT_TIMEOUT_MS, ttlMs: null })

			await image.publish(build.name)
			this.#options.log(`Trainer image: published ${build.name} (${image.imageId})`)

			return image.imageId
		} finally {
			await sandbox.terminate()
		}
	}

	async start(spec: TrainingSandboxSpec): Promise<SandboxState> {
		const app = await this.#appHandle()
		const image = await this.#client.images.fromId(spec.imageID)

		this.#secret ??= this.#options.secretName ? this.#client.secrets.fromName(this.#options.secretName) : null

		const sandbox = await this.#client.sandboxes
			.create(app, image, {
				command: spec.command,
				env: spec.env,
				...(spec.gpu ? { gpu: spec.gpu } : {}),
				cpu: spec.cpu,
				memoryMiB: spec.memoryMiB,
				timeoutMs: spec.timeoutMs,
				volumes: { [this.#options.mount]: await this.#volumeHandle() },
				...(this.#secret ? { secrets: [await this.#secret] } : {}),
				name: spec.name,
				tags: spec.tags,
			})
			.catch((error: unknown) => {
				throw error instanceof AlreadyExistsError ? new SandboxNameTakenError(spec.name) : error
			})

		try {
			for (const file of spec.files) {
				await sandbox.filesystem.writeBytes(file.contents, file.path)
			}
		} catch (error) {
			await sandbox.terminate()

			throw new Error(`sandbox ${sandbox.sandboxId}: the launch inputs could not be written`, { cause: error })
		}

		// The sandbox runs on after this process exits.
		sandbox.detach()

		return { id: sandbox.sandboxId, tags: spec.tags, exitCode: null }
	}

	async list(tags: Record<string, string>, includeFinished = false): Promise<SandboxState[]> {
		const app = await this.#appHandle()
		const found: SandboxState[] = []

		for await (const sandbox of this.#client.sandboxes.list({ appId: app.appId, tags })) {
			const state = { id: sandbox.sandboxId, tags: await sandbox.getTags(), exitCode: await sandbox.poll() }

			if (includeFinished || state.exitCode === null) {
				found.push(state)
			}
		}

		return found
	}

	async get(id: string): Promise<SandboxState> {
		const sandbox = await this.#client.sandboxes.fromId(id)

		return { id, tags: await sandbox.getTags(), exitCode: await sandbox.poll() }
	}

	async logs(id: string, lines: number): Promise<string> {
		const sandbox = await this.#client.sandboxes.fromId(id)
		const messages: string[] = []

		for await (const entry of sandbox.logs.tail({ entries: lines })) {
			messages.push(entry.message)
		}

		return messages.join("")
	}

	async terminate(id: string): Promise<void> {
		await (await this.#client.sandboxes.fromId(id)).terminate()
	}

	async runToCompletion(spec: OneShotSandboxSpec): Promise<{ exitCode: number; output: string }> {
		const app = await this.#appHandle()

		this.#secret ??= this.#options.secretName ? this.#client.secrets.fromName(this.#options.secretName) : null

		if (spec.withSecret && !this.#secret) {
			throw new Error("this sandbox needs the named Modal secret; set MAILWOMAN_MODAL_R2_SECRET")
		}

		const sandbox = await this.#client.sandboxes.create(app, this.#client.images.fromRegistry(spec.registryImage), {
			command: spec.command,
			env: spec.env,
			cpu: spec.cpu,
			memoryMiB: spec.memoryMiB,
			timeoutMs: spec.timeoutMs,
			volumes: { [this.#options.mount]: await this.#volumeHandle() },
			...(spec.withSecret && this.#secret ? { secrets: [await this.#secret] } : {}),
		})

		const [stdout, stderr, exitCode] = await Promise.all([
			sandbox.stdout.readText(),
			sandbox.stderr.readText(),
			sandbox.wait(),
		])

		return { exitCode, output: `${stdout}${stderr}` }
	}

	async fetchDirectory(remoteDir: string, localDir: string): Promise<string[]> {
		const app = await this.#appHandle()

		// A sandbox that idles while the host reads the volume through its filesystem.
		const sandbox = await this.#client.sandboxes.create(app, this.#client.images.fromRegistry(FETCH_IMAGE), {
			command: ["sleep", String(FETCH_TIMEOUT_MS / 1000)],
			cpu: 1,
			memoryMiB: 1024,
			timeoutMs: FETCH_TIMEOUT_MS,
			volumes: { [this.#options.mount]: await this.#volumeHandle() },
		})

		try {
			const fetched: string[] = []
			const pending = [remoteDir.replace(/\/+$/, "")]

			while (pending.length) {
				const dir = pending.pop()!

				for (const entry of await sandbox.filesystem.listFiles(dir)) {
					const remote = `${dir}/${entry.name}`

					if (entry.type === "directory") {
						pending.push(remote)

						continue
					}

					const relative = remote.slice(remoteDir.replace(/\/+$/, "").length + 1)

					await makeDirectories(dirname(resolvePath(localDir, relative)))
					await sandbox.filesystem.copyToLocal(remote, resolvePath(localDir, relative).toString())
					fetched.push(relative)
				}
			}

			if (!fetched.length) throw new Error(`${remoteDir} holds no file on the volume`)

			return fetched.toSorted()
		} finally {
			await sandbox.terminate()
		}
	}
}

/**
 * The image of the sandbox `fetchDirectory` reads the volume through: any image with a shell.
 */
const FETCH_IMAGE = "alpine:3.22"

const FETCH_TIMEOUT_MS = 30 * 60 * 1000

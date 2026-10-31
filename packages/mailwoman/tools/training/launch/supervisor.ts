/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The supervisor a training sandbox runs: a bash script, so the trainer image needs neither Node nor Python.
 *
 *   It writes the launch's YAML and resolved JSON onto the volume, refuses inputs that describe another config or
 *   corpus, checks the device, and runs `trainer train`. It commits the volume after every checkpoint the trainer
 *   saves, and it restarts the trainer after a failed exit, up to the retry count, resuming from the newest complete
 *   checkpoint, or from the branch checkpoint while the run has none. It deletes no
 *   file. The host passes every input through {@linkcode SupervisorEnvironment}.
 */

/**
 * The supervisor's exit code for a refusal a retry would repeat: inputs that describe
 * another config or corpus, or a device other than the requested one.
 */
export const SUPERVISOR_REFUSED_EXIT = 3

/**
 * The trainer's console line for a finished checkpoint, after which the supervisor commits the volume.
 */
export const SAVE_LINE_MARKER = "[save] checkpoint"

/**
 * Every input the supervisor reads, as environment variables.
 */
export interface SupervisorEnvironment {
	/**
	 * One launch's id.
	 * The fault-injection marker file name includes it.
	 *
	 * The marker stays in the run directory, so a marker keyed on the run would turn
	 * off `--fail-at-step` for every later launch of the run.
	 */
	MW_LAUNCH_ID: string
	MW_VOLUME: string
	MW_CONFIG_PATH: string
	MW_RESOLVED_PATH: string
	/**
	 * The container directory the host writes the launch inputs into after the sandbox
	 * starts: `config`, `resolved.json`, then `ready`.
	 *
	 * A sandbox's environment is a Modal secret.
	 * Each value can hold at most 32 KiB, and a resolved config can be larger.
	 */
	MW_INPUTS_DIR: string
	/**
	 * How long the supervisor waits for `ready` before it refuses.
	 */
	MW_INPUTS_WAIT_SECONDS: string
	MW_CONFIG_SHA256: string
	/**
	 * The corpus MANIFEST the preflight receipt was written over, and the sha256 of its bytes on the host.
	 */
	MW_MANIFEST_PATH: string
	MW_MANIFEST_SHA256: string
	/**
	 * The directory beside the checkpoint directory.
	 * It holds the fault-injection marker.
	 */
	MW_RUN_BASE: string
	/**
	 * `cuda` or `cpu`.
	 */
	MW_EXPECT_DEVICE: string
	/**
	 * The checkpoint a branched run starts from, or empty for a run that starts
	 * from `train.init_from` or scratch.
	 *
	 * Every attempt resumes with `auto` once the output directory holds a complete checkpoint,
	 * and from this checkpoint until then, so a retry before the first save keeps the branch point.
	 */
	MW_BRANCH_FROM: string
	MW_THREADS: string
	MW_RETRIES: string
	MW_RETRY_DELAY_SECONDS: string
	/**
	 * `1` clears {@linkcode SupervisorEnvironment.MW_OUTPUT_DIR} once, after the input
	 * and device checks and before the first attempt.
	 *
	 * The host has already refused a directory `checkClearable` rejects.
	 * A restart passes `0`.
	 */
	MW_FRESH: string
	MW_OUTPUT_DIR: string
	/**
	 * Kill the trainer once, after it logs this step.
	 * `0` injects no fault.
	 */
	MW_FAIL_AT_STEP: string
	/**
	 * The commands the supervisor runs.
	 * A test replaces them.
	 */
	MW_TRAINER: string
	MW_SYNC: string
}

/**
 * The supervisor script.
 */
export const SUPERVISOR_SCRIPT = String.raw`set -u
log() { printf '[launch] %s\n' "$*"; }
refuse() { log "refused: $*"; exit ${SUPERVISOR_REFUSED_EXIT}; }
commit() { "$MW_SYNC" "$MW_VOLUME"; }

waited=0
while [ ! -f "$MW_INPUTS_DIR/ready" ]; do
	[ "$waited" -ge "$MW_INPUTS_WAIT_SECONDS" ] && refuse "the launch inputs did not arrive in $MW_INPUTS_DIR within $MW_INPUTS_WAIT_SECONDS s"
	sleep 1
	waited=$((waited + 1))
done
mkdir -p "$(dirname "$MW_CONFIG_PATH")" "$(dirname "$MW_RESOLVED_PATH")" "$MW_RUN_BASE"
cp "$MW_INPUTS_DIR/config" "$MW_CONFIG_PATH"
cp "$MW_INPUTS_DIR/resolved.json" "$MW_RESOLVED_PATH"

config_sha=$(sha256sum "$MW_CONFIG_PATH" | awk '{print $1}')
[ "$config_sha" = "$MW_CONFIG_SHA256" ] || refuse "the staged config's sha256 is $config_sha, the launch's $MW_CONFIG_SHA256"
grep -Eq "\"config_sha256\": *\"$MW_CONFIG_SHA256\"" "$MW_RESOLVED_PATH" ||
	refuse "$MW_RESOLVED_PATH does not describe $MW_CONFIG_PATH"
[ -f "$MW_MANIFEST_PATH" ] || refuse "the corpus MANIFEST $MW_MANIFEST_PATH is not on the volume"
manifest_sha=$(sha256sum "$MW_MANIFEST_PATH" | awk '{print $1}')
[ "$manifest_sha" = "$MW_MANIFEST_SHA256" ] ||
	refuse "the volume's MANIFEST has sha256 $manifest_sha, the preflight's $MW_MANIFEST_SHA256; stage the corpus the receipt was written over"
commit
log "inputs: verified ($MW_CONFIG_PATH, $MW_RESOLVED_PATH)"

"$MW_TRAINER" device --device "$MW_EXPECT_DEVICE" || refuse "trainer device refused $MW_EXPECT_DEVICE"

if [ "$MW_FRESH" = 1 ] && [ -e "$MW_OUTPUT_DIR" ]; then
	rm -rf "$MW_OUTPUT_DIR"
	commit
	log "fresh start: cleared $MW_OUTPUT_DIR"
fi

threads=()
[ "$MW_THREADS" -gt 0 ] && threads=(--threads "$MW_THREADS")
attempt=0
fifo=$(mktemp -u)
marker="$MW_RUN_BASE/fault-injected-$MW_LAUNCH_ID"

while :; do
	# A complete checkpoint is a step directory with its training state, the file a save writes last.
	resume=auto
	if [ -n "$MW_BRANCH_FROM" ] && ! compgen -G "$MW_OUTPUT_DIR/step-*/training_state.json" > /dev/null; then
		resume="$MW_BRANCH_FROM"
	fi
	inject=0
	[ "$MW_FAIL_AT_STEP" -gt 0 ] && [ ! -e "$marker" ] && inject=1
	log "attempt $attempt: trainer train $MW_RESOLVED_PATH --resume $resume"
	mkfifo "$fifo"
	MAILWOMAN_EXPECT_DEVICE="$MW_EXPECT_DEVICE" "$MW_TRAINER" train "$MW_RESOLVED_PATH" --resume "$resume" "${"$"}{threads[@]}" > "$fifo" 2>&1 &
	pid=$!
	outcome=""

	while IFS= read -r line; do
		printf '%s\n' "$line"
		case "$line" in
			device=*)
				chosen=$(printf '%s' "${"$"}{line#device=}" | grep -Eo '^[A-Za-z]+' | tr '[:upper:]' '[:lower:]')
				if [ "$chosen" != "$MW_EXPECT_DEVICE" ]; then
					kill "$pid" 2> /dev/null
					outcome="device:$chosen"
					break
				fi
				;;
			*"${SAVE_LINE_MARKER}"*) commit ;;
			"step "*)
				step=$(printf '%s' "${"$"}{line#step }" | grep -Eo '^[0-9]+')
				if [ "$inject" -eq 1 ] && [ "$step" -ge "$MW_FAIL_AT_STEP" ]; then
					printf 'killed after step %s\n' "$step" > "$marker"
					kill "$pid" 2> /dev/null
					outcome="fault:$step"
					break
				fi
				;;
		esac
	done < "$fifo"

	wait "$pid"
	code=$?
	rm -f "$fifo"
	commit

	case "$outcome" in
		device:*) refuse "trainer chose device ${"$"}{outcome#device:}, this sandbox runs on $MW_EXPECT_DEVICE" ;;
		fault:*) log "controlled failure: killed the trainer after step ${"$"}{outcome#fault:}"; code=1 ;;
	esac

	if [ "$code" -eq 0 ]; then
		log "training complete"
		exit 0
	fi

	if [ "$attempt" -ge "$MW_RETRIES" ]; then
		log "trainer train exited $code after $attempt retries"
		exit "$code"
	fi

	attempt=$((attempt + 1))
	log "trainer train exited $code; retrying in $MW_RETRY_DELAY_SECONDS s"
	sleep "$MW_RETRY_DELAY_SECONDS"
done
`

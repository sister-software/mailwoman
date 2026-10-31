/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Stages a corpus from the R2 bucket onto the training volume, inside a sandbox that mounts the volume.
 *
 *   A file a host writes into the volume is not visible to a mounted container, so the corpus travels R2 → `rclone`
 *   in a sandbox → `sync <mount>`. `mailwoman corpus upload` writes the bucket side. The bucket holds an entry either
 *   nested, `corpus/<entry>/corpus-<entry>/`, or wrapped, `corpus/<entry>/`; both land at
 *   `<mount>/corpus/versioned/<entry>/corpus-<entry>/`, the path a training config's `corpus_dir` names.
 */

/**
 * The registry image the staging sandbox runs.
 */
export const RCLONE_IMAGE = "rclone/rclone:1.69.3"

/**
 * The flags every transfer passes.
 *
 * R2 answers the bucket check with `NotImplemented`, and a large corpus needs the retries.
 */
const RCLONE_FLAGS = "--s3-no-check-bucket --s3-no-head --low-level-retries 30 --retries 8 --transfers 16"

/**
 * The supervisor of a staging sandbox: pick the entry's layout, copy it,
 * check its MANIFEST, and commit the volume.
 *
 * It reads `MW_BUCKET`, `MW_ENTRY`, `MW_MOUNT` and the `RCLONE_S3_*` credentials from its environment.
 * `MW_RCLONE` and `MW_SYNC` identify the commands that a test replaces.
 *
 * @returns Exit 0 once the MANIFEST is on the volume, 1 when the bucket holds
 * no such entry or the copy lacks one.
 */
export const SYNC_SCRIPT = String.raw`set -eu
nested=":s3:$MW_BUCKET/corpus/$MW_ENTRY/corpus-$MW_ENTRY/"
wrapped=":s3:$MW_BUCKET/corpus/$MW_ENTRY/"
destination="$MW_MOUNT/corpus/versioned/$MW_ENTRY/corpus-$MW_ENTRY"

if [ -n "$("$MW_RCLONE" lsf --max-depth 1 ${RCLONE_FLAGS} "$nested" 2> /dev/null | head -n 1)" ]; then
	source="$nested"
elif [ -n "$("$MW_RCLONE" lsf --max-depth 1 ${RCLONE_FLAGS} "$wrapped" 2> /dev/null | head -n 1)" ]; then
	source="$wrapped"
else
	echo "[sync] the bucket $MW_BUCKET holds no corpus/$MW_ENTRY/" >&2
	exit 1
fi

echo "[sync] $source -> $destination"
mkdir -p "$destination"
"$MW_RCLONE" copy ${RCLONE_FLAGS} "$source" "$destination"

if [ ! -f "$destination/MANIFEST.json" ]; then
	echo "[sync] $destination has no MANIFEST.json after the copy" >&2
	exit 1
fi

"$MW_SYNC" "$MW_MOUNT"
echo "[sync] staged $destination"
`

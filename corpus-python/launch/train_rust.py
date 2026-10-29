"""The Rust trainer on Modal: `trainer train` behind the Python launcher's preflight, receipt, retries and resume.

    modal run -d -m launch.train_remote --trainer rust --config <recipe>.yaml [--fresh] [--gpu <type>]

This module is the temporary shell-out the TypeScript launcher (plan Phase 7) replaces. It keeps every guarantee the
Python GPU function gives:

- The local entry point resolves the config on the host with `mailwoman train config resolve`, which also runs the
  source-rights admission, and sends the YAML bytes and the resolved JSON to `stage_launch_inputs`. That function
  writes both under `/data/launch/<config sha256 prefix>/` from inside a container and commits them, because a file
  `modal volume put` writes is invisible to a mounted container. The image therefore needs no Node.
- `preflight` (in `launch/train.py`) runs on the staged YAML and writes the receipt.
- Every attempt of the training function first calls `verify_launch`, which runs `verify_receipt`,
  `resolve_run_paths` and `find_latest_checkpoint` in the training image and refuses without the receipt. The
  attempt then takes the run's lock (`launch/run_lock.py`), which refuses a second call onto a run that is still
  training.
- The attempt runs `trainer train <resolved.json> --resume auto`, or `--resume <branch_from>` while the output
  directory holds no checkpoint. It commits the volume after every checkpoint the trainer saves, and it leaves every
  file on the volume in place.
- The functions run under `modal.Retries` with `single_use_containers=True`, so a failed or preempted attempt is
  retried in a fresh container and resumes from the newest complete checkpoint.

`_train_rust_cpu` runs the same body on the CPU libtorch image. It exists for the lifecycle checks (plan F4) and takes
the two dev-only controls those checks need: ``fail_at_step``, which kills the trainer once per call after it logs
that step, and the entry point's ``--timeout-seconds`` and ``--retries`` overrides.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath

import modal

from .app import VOL_MOUNT, app, trainer_cpu_image, trainer_cuda_image, training_image, vol
from .settings import repository_root, settings
from .wall_clock import TRAIN_TIMEOUT_SECONDS

#: Where `stage_launch_inputs` writes a launch's YAML and resolved JSON on the volume.
LAUNCH_INPUTS_DIR = f"{VOL_MOUNT}/launch"

#: The trainer's console line for a finished optimizer step, `step 10/200  train_loss=…`.
STEP_LINE = re.compile(r"^step (\d+)/(\d+)\b")

#: The trainer's console line after a checkpoint directory is renamed into place.
SAVE_LINE = re.compile(r"\[save\] checkpoint")

#: The trainer's first console line, naming the device it chose: `device=Cuda(0) param_count=…` or `device=Cpu …`.
DEVICE_LINE = re.compile(r"^device=(\w+)")

#: The wall-clock row the CPU function's preflight reads (`DEV_OBSERVED_SECONDS_PER_100_STEPS`).
CPU_DEVICE = "cpu"


def config_source_path(config: str) -> Path:
    """The host YAML a launch names: a path to an existing file, otherwise a name under the package's configs."""
    given = Path(config)
    if given.is_file():
        return given.resolve()
    packaged = repository_root() / "corpus-python" / "src" / "mailwoman_train" / "configs" / config
    if packaged.is_file():
        return packaged
    raise FileNotFoundError(f"no config {config!r}: not a file, and not under {packaged.parent}")


def resolve_on_host(config: str) -> tuple[str, bytes, str]:
    """The config's file name, its bytes, and the resolved JSON `mailwoman train config resolve` writes for it.

    The resolver refuses a config whose sources the register does not admit, so this is the Rust launch's source-rights
    check. It runs from the compiled CLI. `yarn compile` writes that CLI.
    """
    source = config_source_path(config)
    cli = repository_root() / "packages" / "mailwoman" / "out" / "cli" / "main.js"
    if not cli.is_file():
        raise FileNotFoundError(f"{cli} is missing; run `yarn compile` before a Rust launch")
    with tempfile.TemporaryDirectory() as scratch:
        out = Path(scratch) / "resolved.json"
        subprocess.run(["node", str(cli), "train", "config", "resolve", str(source), "--out", str(out)], check=True)
        resolved = out.read_text(encoding="utf-8")
    text = source.read_bytes()
    recorded = json.loads(resolved).get("config_sha256")
    if recorded != hashlib.sha256(text).hexdigest():
        raise RuntimeError(f"the resolver recorded config_sha256 {recorded} for {source}, not the file's sha256")
    return source.name, text, resolved


def staged_paths(config_name: str, config_sha256: str) -> tuple[str, str]:
    """The volume paths of a launch's YAML and resolved JSON, keyed by the YAML's sha256."""
    directory = PurePosixPath(LAUNCH_INPUTS_DIR) / config_sha256[:16]
    return str(directory / config_name), str(directory / "resolved.json")


def trainer_command(resolved_path: str, resume: str, threads: int) -> list[str]:
    """The `trainer train` command line for one attempt."""
    command = ["trainer", "train", resolved_path, "--resume", resume]
    if threads > 0:
        command += ["--threads", str(threads)]
    return command


def call_is_running(call_id: str) -> bool:
    """Whether the Modal function call ``call_id`` has no result yet, including while it waits for a retry."""
    try:
        modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:  # the builtin, while the call has no result; `FunctionTimeoutError` is an outcome
        return True
    except Exception:  # noqa: BLE001 -- a failed, cancelled or expired call holds nothing
        return False
    return False


@app.function(image=training_image, volumes={VOL_MOUNT: vol}, timeout=600)
def stage_launch_inputs(config_name: str, config_text: bytes, resolved_text: str) -> dict[str, str]:
    """Write a launch's YAML bytes and resolved JSON onto the volume from inside a container, and commit them."""
    digest = hashlib.sha256(config_text).hexdigest()
    if json.loads(resolved_text).get("config_sha256") != digest:
        raise ValueError(f"the resolved config does not describe {config_name} (sha256 {digest})")
    config_path, resolved_path = staged_paths(config_name, digest)
    vol.reload()
    Path(config_path).parent.mkdir(parents=True, exist_ok=True)
    Path(config_path).write_bytes(config_text)
    Path(resolved_path).write_text(resolved_text, encoding="utf-8")
    vol.commit()
    print(f"Staged {config_path} and {resolved_path}")
    return {"config_path": config_path, "resolved_path": resolved_path, "config_sha256": digest}


@app.function(image=training_image, volumes={VOL_MOUNT: vol}, timeout=600)
def verify_launch(config_path: str, preflight_token: str, branch_from: str = "") -> dict[str, str]:
    """Verify the preflight receipt and decide where an attempt starts, with the Python launcher's own helpers.

    It runs in the training image because `verify_receipt` and `find_latest_checkpoint` import the training package.
    The trainer image does not hold that package. It raises `PreflightReceiptError` without a matching receipt.
    """
    import sys

    vol.reload()
    sys.path.insert(0, f"{VOL_MOUNT}/corpus-python/src")

    from mailwoman_train.audits.preflight import config_sha256, verify_receipt
    from mailwoman_train.config import load_config
    from mailwoman_train.train.checkpoint import find_latest_checkpoint

    from .resume import resolve_run_paths, resume_point
    from .train import required_audits

    cfg = load_config(Path(config_path))
    audits = required_audits(cfg)
    verify_receipt(Path(f"{VOL_MOUNT}/audits"), Path(config_path), Path(cfg.data.corpus_dir), preflight_token, audits)
    paths = resolve_run_paths(cfg.train.output_dir, cfg.train.csv_log_path, VOL_MOUNT)
    latest = find_latest_checkpoint(Path(paths.output_dir))
    start = resume_point(str(latest) if latest is not None else None, branch_from)
    return {
        "audits": ", ".join(audits),
        "config_sha256": config_sha256(Path(config_path)),
        "output_dir": paths.output_dir,
        "run_base": paths.run_base,
        "latest": str(latest) if latest is not None else "",
        "start": start or "",
    }


def _run_trainer(
    config_path: str,
    resolved_path: str,
    preflight_token: str,
    branch_from: str,
    threads: int,
    fail_at_step: int,
    expect_device: str,
) -> None:
    """One attempt: verify, lock, run `trainer train`, commit after each checkpoint, and raise on a failed exit.

    ``expect_device`` is the device the trainer must report choosing (`Cuda` or `Cpu`); any other ends the attempt.
    """
    from .run_lock import acquire

    call_id = modal.current_function_call_id() or ""
    print(f"Function call: {call_id}")
    vol.reload()

    launch = verify_launch.remote(config_path, preflight_token, branch_from)
    print(f"Preflight receipt: verified ({launch['audits']})")

    resolved = json.loads(Path(resolved_path).read_text(encoding="utf-8"))
    if resolved.get("config_sha256") != launch["config_sha256"]:
        raise RuntimeError(f"{resolved_path} does not describe {config_path}; re-stage the launch")
    output_dir = resolved["config"]["train"]["output_dir"]
    if output_dir != launch["output_dir"]:
        raise RuntimeError(
            f"the resolved output_dir {output_dir} is not the launcher's {launch['output_dir']}; a Rust run's "
            f"output_dir must sit under {VOL_MOUNT}"
        )

    run_base = Path(launch["run_base"])
    decision = acquire(run_base, call_id, launch["config_sha256"], call_is_running)
    vol.commit()
    print(f"Run lock: {decision.action} ({run_base}/LAUNCH_LOCK.json)")

    # `--resume auto` picks the newest complete checkpoint, as `find_latest_checkpoint` did above. The branch point is
    # passed only while the output directory holds no checkpoint.
    resume = "auto" if launch["latest"] or not branch_from else branch_from
    command = trainer_command(resolved_path, resume, threads)
    print(f"Output: {output_dir}")
    print(f"Resume: {launch['latest'] or launch['start'] or 'none (from scratch)'}")
    print(f"Command: {' '.join(command)}\n", flush=True)

    marker = run_base / f"fault-injected-{call_id}"
    inject = fail_at_step > 0 and not marker.exists()
    # The trainer refuses on its own when the device it gets is not this one, before it opens the corpus.
    environment = {**os.environ, "MAILWOMAN_EXPECT_DEVICE": expect_device.lower()}
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=environment
    )
    assert process.stdout is not None
    try:
        for line in process.stdout:
            print(line, end="", flush=True)
            device = DEVICE_LINE.match(line)
            if device and device.group(1) != expect_device:
                # `trainer` takes the first CUDA device when there is one, so a CUDA failure would train on the CPU.
                process.kill()
                process.wait()
                raise RuntimeError(f"trainer chose device {device.group(1)}, this function runs on {expect_device}")
            if SAVE_LINE.search(line):
                vol.commit()
            step = STEP_LINE.match(line)
            if inject and step and int(step.group(1)) >= fail_at_step:
                marker.write_text(f"killed after step {step.group(1)}\n", encoding="utf-8")
                process.kill()
                process.wait()
                vol.commit()
                raise RuntimeError(f"controlled failure: killed the trainer after step {step.group(1)} (F4)")
        code = process.wait()
    finally:
        if process.poll() is None:
            process.kill()
        vol.commit()
    if code != 0:
        raise RuntimeError(f"trainer train exited {code}")

    print(f"\nTraining complete. Output at {run_base}/")
    for root, _dirs, files in os.walk(run_base):
        for name in sorted(files):
            path = os.path.join(root, name)
            print(f"  {os.path.relpath(path, run_base)}: {os.path.getsize(path) / 1e6:.1f} MB")


_RETRIES = modal.Retries(max_retries=settings().train_retries, initial_delay=10.0, backoff_coefficient=2.0)


@app.function(
    image=trainer_cuda_image,
    volumes={VOL_MOUNT: vol},
    gpu=settings().train_gpu,
    cpu=8.0,
    timeout=TRAIN_TIMEOUT_SECONDS,
    memory=32768,
    retries=_RETRIES,
    single_use_containers=True,
)
def _train_rust_gpu(
    config_path: str, resolved_path: str, preflight_token: str, branch_from: str = "", threads: int = 0
) -> None:
    """Train one staged config with the Rust trainer on CUDA libtorch, after verifying its preflight receipt."""
    _run_trainer(config_path, resolved_path, preflight_token, branch_from, threads, 0, expect_device="Cuda")


@app.function(
    image=trainer_cpu_image,
    volumes={VOL_MOUNT: vol},
    cpu=4.0,
    timeout=TRAIN_TIMEOUT_SECONDS,
    memory=16384,
    retries=_RETRIES,
    single_use_containers=True,
)
def _train_rust_cpu(
    config_path: str,
    resolved_path: str,
    preflight_token: str,
    branch_from: str = "",
    threads: int = 0,
    fail_at_step: int = 0,
) -> None:
    """The same run on CPU libtorch, for the lifecycle checks. ``fail_at_step`` kills the trainer once per call."""
    _run_trainer(config_path, resolved_path, preflight_token, branch_from, threads, fail_at_step, expect_device="Cpu")


def launch_rust(
    config: str,
    fresh: bool,
    branch_from: str,
    gpu: str,
    cpu: bool,
    threads: int,
    fail_at_step: int,
    timeout_seconds: int,
    retries: int,
) -> None:
    """The entry point's Rust path: resolve on the host, stage, preflight, then spawn and print the call id."""
    from .train import preflight

    if fail_at_step and not cpu:
        raise ValueError("--fail-at-step is a lifecycle check control and runs on the CPU function only (--cpu)")
    name, text, resolved = resolve_on_host(config)
    staged = stage_launch_inputs.remote(name, text, resolved)
    device = CPU_DEVICE if cpu else (gpu or settings().train_gpu)
    print(f"Preflighting {staged['config_path']} for {device}{' (fresh start)' if fresh else ''}...")
    token = preflight.remote(config_name=staged["config_path"], gpu=device, fresh=fresh)

    # `with_options` leaves an option that is passed as `None` at the function's own value.
    override_gpu = gpu if gpu and not cpu else None
    override_timeout = timeout_seconds if timeout_seconds > 0 else None
    override_retries = (
        modal.Retries(max_retries=retries, initial_delay=10.0, backoff_coefficient=2.0) if retries >= 0 else None
    )
    common = (staged["config_path"], staged["resolved_path"], token, branch_from, threads)
    if cpu:
        cpu_function = _train_rust_cpu.with_options(timeout=override_timeout, retries=override_retries)
        call = cpu_function.spawn(*common, fail_at_step)
    else:
        gpu_function = _train_rust_gpu.with_options(
            gpu=override_gpu, timeout=override_timeout, retries=override_retries
        )
        call = gpu_function.spawn(*common)
    print(f"\nSpawned Rust training: function_call_id={call.object_id} device={device}")
    print(f"Dashboard: {call.get_dashboard_url()}")
    print(f"Status: (cd corpus-python && uv run --extra dev python -m launch.call_status {call.object_id})")

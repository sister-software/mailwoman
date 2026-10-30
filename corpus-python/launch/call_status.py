"""Read, tail or cancel a spawned training call from any shell, by the id the launch printed.

    uv run --extra dev python -m launch.call_status fc-…
    uv run --extra dev python -m launch.call_status fc-… --wait 600
    uv run --extra dev python -m launch.call_status fc-… --logs 50
    uv run --extra dev python -m launch.call_status fc-… --cancel

This starts no container and runs no app. It prints `running` while the call has no result, `finished`
when it returned, and re-raises the remote error when it failed, so the exit status is the verdict.
`--logs` prints the call's most recent log lines first. `--cancel` cancels the call and terminates its
container. A cancelled call is not retried.
"""

from __future__ import annotations

import argparse
import sys

import modal


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("call_id", help="the function_call_id the launch printed")
    parser.add_argument("--wait", type=float, default=0.0, help="seconds to wait for a result (default: 0)")
    parser.add_argument("--logs", type=int, default=0, help="print this many of the call's latest log lines")
    parser.add_argument("--cancel", action="store_true", help="cancel the call and terminate its container")
    args = parser.parse_args(argv)

    call = modal.FunctionCall.from_id(args.call_id)
    print(f"Dashboard: {call.get_dashboard_url()}")
    if args.logs > 0:
        for entry in call.logs.tail(args.logs):
            print(f"{entry.timestamp.isoformat(timespec='seconds')} {entry.message.rstrip()}")
    if args.cancel:
        call.cancel(terminate_containers=True)
        print("cancelled")
        return 0
    try:
        result = call.get(timeout=args.wait)
    # The client raises the builtin while the call has no result. `modal.exception.TimeoutError` is not that signal:
    # its subclass `FunctionTimeoutError` is the outcome of a call that hit its timeout, and re-raises as the verdict.
    except TimeoutError:
        print("running")
        return 0
    # A Rust training call returns its refusal rather than raising it, so Modal does not retry it.
    if isinstance(result, dict) and result.get("refused"):
        print(f"refused: {result['refused']}")
        return 1
    print("finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())

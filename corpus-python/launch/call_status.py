"""Read a spawned training call's state from any shell, by the id the launch printed.

    uv run --extra dev python -m launch.call_status fc-…
    uv run --extra dev python -m launch.call_status fc-… --wait 600

This starts no container and runs no app. It prints `running` while the call has no result, `finished`
when it returned, and re-raises the remote error when it failed, so the exit status is the verdict.
"""

from __future__ import annotations

import argparse
import sys

import modal


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("call_id", help="the function_call_id the launch printed")
    parser.add_argument("--wait", type=float, default=0.0, help="seconds to wait for a result (default: 0)")
    args = parser.parse_args(argv)

    call = modal.FunctionCall.from_id(args.call_id)
    print(f"Dashboard: {call.get_dashboard_url()}")
    try:
        call.get(timeout=args.wait)
    except modal.exception.TimeoutError:
        print("running")
        return 0
    print("finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())

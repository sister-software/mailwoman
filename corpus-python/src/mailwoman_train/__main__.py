"""``python -m mailwoman_train`` entrypoint — delegates to ``cli.main``."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())

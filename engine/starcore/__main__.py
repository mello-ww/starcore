import sys

from .cli.main import main

if __name__ == "__main__":
    # `python -m starcore <command> ...` runs one command and exits with its
    # exit code; with no arguments StarCore itself starts (see docs/cli.md)
    if len(sys.argv) > 1:
        from .cli import bridge
        sys.exit(bridge.main(sys.argv[1:]))
    main()

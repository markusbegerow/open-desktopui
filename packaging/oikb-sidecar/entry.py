# PyInstaller needs a real script file as its entry point (not just a
# `-m module` invocation) — this just calls straight into oikb's own CLI
# (`oikb-main/src/oikb/cli.py`'s `cli` group), unmodified.
from oikb.cli import cli

if __name__ == "__main__":
    cli()

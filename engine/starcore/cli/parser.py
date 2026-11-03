def parse(command: str, engine, registry=None):
    """Kept for callers of the original entry point: runs `command` as the
    terminal operator, exactly like StarCore.execute_command()."""
    return engine.execute_command(command)

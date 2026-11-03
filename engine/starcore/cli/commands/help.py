from .. import runner

COMMAND = {
    "description": "Display help information.",
    "usage": "help [namespace [command]]",
    "aliases": [],
    "category": "Core",
    "read_only": True,
    "examples": [
        "help",
        "help engine",
        "help engine health",
        "help --json",
    ]
}


# The runner answers "help" itself, so it can filter by who is asking and
# honour --json; this entry keeps "help" registered and listed like any other.
def help(engine, args):
    context = runner.terminal_context(engine)
    try:
        print(runner.render_help(runner.help_data(engine, context, list(args))))
    except runner.UsageError as error:
        print(f"[ERROR]: {error}")

"""Runs one command line for any caller - the terminal, the one-shot CLI, or
the Mission Control / mobile console - with the same parsing, authorization,
confirmation, output and exit codes. See docs/cli.md.

Nothing here executes a shell or evaluates text: a command line is split
into plain string tokens and every token is handed to a registered
command's own typed arguments.
"""

from contextlib import redirect_stdout
from dataclasses import dataclass
import difflib
import io
import json
import shlex

from . import spec
from .spec import (CommandError, ConfirmationRequired, Context, NotFound, PermissionDenied, Result, Unavailable,
                   UsageError)

GLOBAL_FLAGS = {"--json": "json", "--yes": "yes", "-y": "yes", "--help": "help", "-h": "help"}
MAX_TOKENS = 256
MAX_TOKEN_LENGTH = 4096

# What each surface may do. Nothing else ever widens these - not a config
# switch, not a "developer" mode, not a flag on the command line.
OPERATOR_GRANTS = frozenset({"*.read", "*.control", "*.manage"})
REMOTE_GRANTS = frozenset({"*.read", "*.control"})


@dataclass
class Outcome:
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    result: object = None  # an older single-function command's own return value
    confirm: str = None  # the question to ask, when the command stopped for confirmation

    @property
    def output(self) -> str:
        return self.stdout + self.stderr


# ---------- contexts ----------

def terminal_context(engine, interactive: bool = False) -> Context:
    """The operator at StarCore's own terminal: the person running the server."""
    return Context(engine, "terminal", OPERATOR_GRANTS, actor="terminal", user=_account(engine),
                   interactive=interactive, confirm=_ask if interactive else None)


def local_context(engine) -> Context:
    """The one-shot CLI (`python -m starcore <command>`), run by the same OS
    account that owns StarCore's data directory. Never interactive here -
    prompting happens in the client process before anything is sent."""
    return Context(engine, "local", OPERATOR_GRANTS, actor="local-cli", user=_account(engine))


def remote_context(engine, token: str = "") -> Context:
    """A signed-in Mission Control or mobile console session."""
    auth = engine.auth
    user = auth.session_username(token) if auth.is_bootstrapped else None
    session = auth.session_id(token) if auth.is_bootstrapped else ""
    return Context(engine, "remote", REMOTE_GRANTS, actor=f"session:{session}" if session else "session:anonymous",
                   user=user or None)


def _account(engine):
    return getattr(engine.auth, "username", None)


def _ask(prompt: str) -> bool:
    try:
        return input(f"{prompt} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        return False


# ---------- entry point ----------

def tokenize(line: str) -> list:
    """Quotes group words; backslashes stay literal so Windows paths survive."""
    lexer = shlex.shlex(line, posix=True)
    lexer.whitespace_split = True
    lexer.escape = ""
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError as error:
        raise UsageError(f"could not read the command line ({error})")


def run(engine, line, context: Context) -> Outcome:
    json_requested = context.json
    try:
        tokens = tokenize(line) if isinstance(line, str) else [str(token) for token in line]
        if len(tokens) > MAX_TOKENS or any(len(token) > MAX_TOKEN_LENGTH for token in tokens):
            raise UsageError("the command line is too long")
        tokens, flags = _global_flags(tokens)
        json_requested = context.json = context.json or flags["json"]
        context.assume_yes = context.assume_yes or flags["yes"]
        if tokens and tokens[0] == "starcore":
            tokens = tokens[1:]
        if not tokens or tokens[0] == "help":
            return _ok(context, "help", help_data(engine, context, tokens[1:]), render_help)
        return _dispatch(engine, tokens, flags["help"], context)
    except CommandError as error:
        return _failure(context, None, error, json_requested)


def _global_flags(tokens: list):
    flags = {"json": False, "yes": False, "help": False}
    kept = []
    for index, token in enumerate(tokens):
        if token == "--":
            kept += tokens[index:]
            break
        if token in GLOBAL_FLAGS:
            flags[GLOBAL_FLAGS[token]] = True
        else:
            kept.append(token)
    return kept, flags


def _dispatch(engine, tokens: list, wants_help: bool, context: Context) -> Outcome:
    registry = engine.command_registry
    entry = registry.get(tokens[0])
    if entry is None:
        raise UsageError(f"command '{tokens[0]}' not found in registry.{_suggest(tokens[0], registry.all())}")

    namespace = entry.get("namespace")
    if namespace is None:
        if wants_help:
            return _ok(context, "help", help_data(engine, context, tokens[:1]), render_help)
        return _run_legacy(engine, tokens, entry, context)

    rest = tokens[1:]
    command = namespace.get(rest[0]) if rest else None
    if command is None and wants_help:
        return _ok(context, "help", help_data(engine, context, [namespace.name]), render_help)
    if command is not None:
        rest = rest[1:]
    elif namespace.default and (not rest or rest[0].startswith("-")):
        command = namespace.get(namespace.default)
    elif not rest:
        return _ok(context, "help", help_data(engine, context, [namespace.name]), render_help)
    else:
        raise UsageError(f"'{namespace.name}' has no command '{rest[0]}'.{_suggest(rest[0], namespace.commands)} "
                         f"Usage: {namespace.name} <command> [options] - run 'help {namespace.name}' for the list.")

    if wants_help:
        return _ok(context, "help", help_data(engine, context, [namespace.name, command.name]), render_help)
    return _run_typed(engine, command, namespace, rest, context)


def _suggest(word: str, names) -> str:
    close = difflib.get_close_matches(word, list(names), n=1)
    return f" Did you mean '{close[0]}'?" if close else ""


# ---------- typed commands ----------

def refusal(engine, command, namespace, context: Context):
    """None if `context` may run `command`, else the CommandError explaining why."""
    if context.surface == "remote" and not command.remote:
        return PermissionDenied(f"'{command.path}' can only be run from the StarCore terminal or CLI")
    if not spec.permitted(context.permissions, command.permission):
        return PermissionDenied(f"'{command.path}' needs the '{command.permission}' permission")
    if namespace.source != "core":
        satellite = engine.registry.get(namespace.source)
        if satellite is None:
            return Unavailable(f"the {namespace.source} satellite is not loaded")
        if not satellite.enabled:
            return Unavailable(f"the {namespace.source} satellite is disabled - "
                               f"enable it with 'satellites enable {namespace.source}'")
    if command.requires_live and not context.live:
        return Unavailable(f"'{command.path}' needs StarCore to be running - start it, then run this again")
    return None


def _run_typed(engine, command, namespace, tokens: list, context: Context) -> Outcome:
    values = None
    try:
        refused = refusal(engine, command, namespace, context)
        if refused is not None:
            raise refused
        values = spec.parse_arguments(command, tokens)
        if command.confirm and not context.assume_yes:
            if not (context.interactive and context.confirm):
                needed = ConfirmationRequired(f"{command.confirm} Re-run with --yes to confirm.")
                needed.prompt = command.confirm
                raise needed
            if not context.confirm(command.confirm):
                raise ConfirmationRequired("cancelled")
        result = command.handler(context, **values)
    except CommandError as error:
        _audit(engine, context, command, values, error.code, error.exit_code)
        return _failure(context, command, error, context.json)
    except LookupError as error:
        error = NotFound(str(error).strip("'\"") or "not found")
        _audit(engine, context, command, values, error.code, error.exit_code)
        return _failure(context, command, error, context.json)
    except ValueError as error:
        error = CommandError(str(error))
        _audit(engine, context, command, values, error.code, error.exit_code)
        return _failure(context, command, error, context.json)
    except Exception as error:
        print(f"[WARNING]: command '{command.path}' failed: {type(error).__name__}: {error}")
        error = CommandError(f"internal error ({type(error).__name__})")
        _audit(engine, context, command, values, error.code, error.exit_code)
        return _failure(context, command, error, context.json)

    if not isinstance(result, Result):
        result = Result(data=result)
    _audit(engine, context, command, values, "ok", spec.EXIT_OK)
    return _ok(context, command.path, result.data, command.render, result.text)


def _audit(engine, context, command, values, outcome: str, exit_code: int):
    if not (command.mutates or command.sensitive or outcome in ("denied", "confirmation_required")):
        return
    _record(engine, context, command.path, spec.redacted(command, values) if values is not None else None,
            outcome, exit_code)


def _record(engine, context, path: str, arguments, outcome: str, exit_code: int):
    audit = getattr(engine, "audit", None)
    if audit is None:
        return
    audit.record({
        "surface": context.surface,
        "actor": context.actor,
        "user": context.user,
        "command": path,
        "arguments": arguments,
        "outcome": outcome,
        "exit_code": exit_code,
    })


def _ok(context, path: str, data, render=None, text: str = None) -> Outcome:
    if context.json:
        return Outcome(spec.EXIT_OK, _dump({"ok": True, "command": path, "exit_code": 0, "data": data}))
    if text is None:
        text = render(data) if render else render_value(data)
    return Outcome(spec.EXIT_OK, text.rstrip("\n") + "\n" if text else "")


def _failure(context, command, error: CommandError, as_json: bool) -> Outcome:
    prompt = getattr(error, "prompt", None)
    if as_json:
        return Outcome(error.exit_code, _dump({
            "ok": False, "command": command.path if command else None, "exit_code": error.exit_code,
            "error": {"code": error.code, "message": str(error)},
            **({"data": error.data} if getattr(error, "data", None) is not None else {}),
        }), confirm=prompt)
    return Outcome(error.exit_code, stderr=f"[ERROR]: {error}\n", confirm=prompt)


def _dump(payload) -> str:
    return json.dumps(payload, indent=2, default=str, ensure_ascii=False) + "\n"


# ---------- older single-function commands ----------

def _run_legacy(engine, tokens: list, entry: dict, context: Context) -> Outcome:
    metadata = entry.get("metadata") or {}
    read_only = bool(metadata.get("read_only"))
    # an older command says nothing about what it changes, so a remote
    # console may only run the ones that declare themselves read-only
    if context.surface == "remote" and not read_only:
        _record(engine, context, tokens[0], None, "denied", spec.EXIT_DENIED)
        raise PermissionDenied(f"'{tokens[0]}' can only be run from the StarCore terminal or CLI")
    if context.json:
        raise UsageError(f"'{tokens[0]}' has no JSON output")

    buffer = io.StringIO()
    with redirect_stdout(buffer):
        result = entry["function"](engine, tokens[1:])
    stdout = buffer.getvalue()
    if result is not None and context.surface != "terminal":
        stdout += f"{result}\n"
    failed = any(line.startswith("[ERROR]") for line in stdout.splitlines())
    code = spec.EXIT_FAILED if failed else spec.EXIT_OK
    if not read_only:
        # its argument values are only kept when the command says they hold
        # nothing secret; otherwise just how many there were
        arguments = {"argv": tokens[1:]} if metadata.get("audit_arguments") else {"count": len(tokens) - 1}
        _record(engine, context, tokens[0], arguments, "failed" if failed else "ok", code)
    return Outcome(code, stdout, result=result)


# ---------- help ----------

def help_data(engine, context: Context, topic: list) -> dict:
    """Help as data. With --json only what this caller may run is listed, so
    the result can be handed to an automated client as its command schema."""
    registry = engine.command_registry
    if len(topic) > 2:
        raise UsageError("Usage: help [namespace [command]]")

    if not topic:
        entries = []
        for name, entry in registry.all().items():
            namespace = entry.get("namespace")
            if namespace is None:
                metadata = entry["metadata"] or {}
                if context.json and context.surface == "remote" and not metadata.get("read_only"):
                    continue
                entries.append({"name": name, "summary": metadata.get("description", ""), "source": entry["source"],
                                "usage": metadata.get("usage", name), "typed": False})
                continue
            commands = _visible(engine, namespace, context)
            if context.json and not commands:
                continue
            entries.append({"name": name, "summary": namespace.summary, "source": entry["source"], "typed": True,
                            "aliases": list(namespace.aliases), "commands": commands})
        return {"topic": None, "entries": entries}

    entry = registry.get(topic[0])
    if entry is None:
        raise UsageError(f"command '{topic[0]}' not found in registry.{_suggest(topic[0], registry.all())}")
    namespace = entry.get("namespace")
    if namespace is None:
        if len(topic) > 1:
            raise UsageError(f"'{topic[0]}' has no subcommands")
        return {"topic": topic[0], "legacy": {"name": topic[0], "source": entry["source"],
                                              **(entry["metadata"] or {})}}
    if len(topic) == 1:
        return {"topic": namespace.name, "namespace": {
            "name": namespace.name, "summary": namespace.summary, "source": namespace.source,
            "aliases": list(namespace.aliases), "default": namespace.default,
            "commands": _visible(engine, namespace, context)}}
    command = namespace.get(topic[1])
    if command is None:
        raise UsageError(f"'{namespace.name}' has no command '{topic[1]}'.{_suggest(topic[1], namespace.commands)}")
    return {"topic": command.path, "command": _describe(engine, command, namespace, context)}


def _visible(engine, namespace, context) -> list:
    described = [_describe(engine, command, namespace, context) for command in namespace.unique()]
    return [item for item in described if item["available"]] if context.json else described


def _describe(engine, command, namespace, context) -> dict:
    refused = refusal(engine, command, namespace, context)
    return {**command.schema(), "available": refused is None, "unavailable_reason": str(refused) if refused else None}


def render_help(data: dict) -> str:
    if data.get("legacy"):
        return _render_legacy_help(data["legacy"])
    if data.get("command"):
        return _render_command_help(data["command"])
    if data.get("namespace"):
        namespace = data["namespace"]
        lines = [f"{namespace['name']} - {namespace['summary']}"]
        if namespace["source"] != "core":
            lines.append(f"Provided by the {namespace['source']} satellite.")
        lines.append("")
        commands = namespace["commands"]
        width = max((len(command["name"]) for command in commands), default=0)
        for command in commands:
            marker = "" if command["available"] else f"  ({command['unavailable_reason']})"
            lines.append(f"  {command['name']:<{width}}  {command['summary']}{marker}")
        if namespace["default"]:
            lines.append(f"\n'{namespace['name']}' on its own runs '{namespace['name']} {namespace['default']}'.")
        lines.append(f"Run '{namespace['name']} <command> --help' for its arguments and options.")
        return "\n".join(lines)

    lines = ["StarCore commands", ""]
    width = max((len(entry["name"]) for entry in data["entries"]), default=0)
    for entry in data["entries"]:
        source = f"  [{entry['source']}]" if entry["source"] != "core" else ""
        lines.append(f"  {entry['name']:<{width}}  {entry['summary']}{source}")
    lines += ["", "Run 'help <namespace>' for its commands, or '<namespace> <command> --help' for one command.",
              "Global options: --json (machine-readable output), --yes (confirm without asking), --help"]
    return "\n".join(lines)


def _render_command_help(command: dict) -> str:
    lines = [command["command"], "", f"  {command['description']}", "", "Usage", f"  {command['usage']}"]
    if command["arguments"]:
        lines += ["", "Arguments"]
        for argument in command["arguments"]:
            choices = f" (one of: {', '.join(map(str, argument['choices']))})" if argument["choices"] else ""
            lines.append(f"  {argument['name']:<14}  {argument['help']}{choices}")
    if command["options"]:
        lines += ["", "Options"]
        for option in command["options"]:
            default = f" (default: {option['default']})" if option["default"] not in (None, False) else ""
            choices = f" (one of: {', '.join(map(str, option['choices']))})" if option["choices"] else ""
            lines.append(f"  {option['name']:<14}  {option['help']}{choices}{default}")
    behaviour = "read-only" if command["read_only"] else "changes state"
    if command["confirmation"]:
        behaviour += ", asks for confirmation (--yes to skip)"
    lines += ["", "Behaviour", f"  {behaviour}; needs '{command['permission']}'"
              f"{'' if command['remote'] else '; terminal and CLI only'}"]
    if not command["available"]:
        lines.append(f"  Not available here: {command['unavailable_reason']}")
    if command["examples"]:
        lines += ["", "Examples"] + [f"  {example}" for example in command["examples"]]
    return "\n".join(lines)


def _render_legacy_help(metadata: dict) -> str:
    lines = [metadata["name"], "", "Description", f"  {metadata.get('description', '')}", "",
             "Usage", f"  {metadata.get('usage', metadata['name'])}"]
    if metadata.get("aliases"):
        lines += ["", "Aliases", f"  {', '.join(metadata['aliases'])}"]
    if metadata.get("category"):
        lines += ["", "Category", f"  {metadata['category']}"]
    if metadata.get("source", "core") != "core":
        lines += ["", "Satellite", f"  {metadata['source']}"]
    if metadata.get("examples"):
        lines += ["", "Examples"] + [f"  {example}" for example in metadata["examples"]]
    return "\n".join(lines)


# ---------- generic rendering ----------

def render_value(data) -> str:
    """A readable fallback for commands without their own renderer."""
    if data is None:
        return ""
    if isinstance(data, dict):
        width = max((len(str(key)) for key in data), default=0)
        return "\n".join(f"{str(key).replace('_', ' ').capitalize():<{width}}  {_scalar(value)}"
                         for key, value in data.items())
    if isinstance(data, list):
        return "\n".join(_scalar(item) for item in data)
    return str(data)


def _scalar(value) -> str:
    if isinstance(value, bool):
        return "yes" if value else "no"
    if value is None:
        return "-"
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str, ensure_ascii=False)
    return str(value)


def table(rows: list, columns: list) -> str:
    """rows of dicts -> aligned text; columns is [(key, title), ...]."""
    if not rows:
        return ""
    cells = [[_scalar(row.get(key)) for key, _ in columns] for row in rows]
    widths = [max(len(title), *(len(cell[index]) for cell in cells)) for index, (_, title) in enumerate(columns)]
    lines = ["  ".join(title.ljust(widths[index]) for index, (_, title) in enumerate(columns)).rstrip()]
    lines += ["  ".join(cell[index].ljust(widths[index]) for index in range(len(columns))).rstrip() for cell in cells]
    return "\n".join(lines)

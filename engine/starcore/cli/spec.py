"""Typed command definitions shared by the Engine and every Satellite.

A command module (engine/starcore/cli/commands/*.py or a Satellite's own
commands/*.py) declares `NAMESPACE` and `COMMANDS` built from the classes
here. The loader registers them into the same CommandRegistry the older
single-function commands use (see docs/cli.md), and starcore.cli.runner
parses, authorizes, confirms, runs, renders and audits them - so no command
re-implements any of that itself.

A definition is pure data plus a handler. That keeps every command
describable as a schema (see Command.schema()), filtered by what the caller
may run, without ever executing it.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

# ---------- exit codes ----------

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_DENIED = 3
EXIT_NOT_FOUND = 4
EXIT_UNAVAILABLE = 5
EXIT_CONFIRMATION = 6
EXIT_TIMEOUT = 7

ERROR_CODES = {
    "failed": EXIT_FAILED,
    "usage": EXIT_USAGE,
    "denied": EXIT_DENIED,
    "not_found": EXIT_NOT_FOUND,
    "unavailable": EXIT_UNAVAILABLE,
    "confirmation_required": EXIT_CONFIRMATION,
    "timeout": EXIT_TIMEOUT,
}


class CommandError(Exception):
    """A command could not do what was asked. `code` picks the exit code."""

    code = "failed"

    def __init__(self, message: str, code: str = None, data=None):
        super().__init__(message)
        if code is not None:
            self.code = code
        self.data = data  # optional detail, included in --json output

    @property
    def exit_code(self) -> int:
        return ERROR_CODES.get(self.code, EXIT_FAILED)


class UsageError(CommandError):
    code = "usage"


class PermissionDenied(CommandError):
    code = "denied"


class NotFound(CommandError):
    code = "not_found"


class Unavailable(CommandError):
    code = "unavailable"


class ConfirmationRequired(CommandError):
    code = "confirmation_required"


class CommandTimeout(CommandError):
    code = "timeout"


# ---------- permissions ----------
#
# A permission is "<area>.<level>". Levels:
#   read     look at state, never change it
#   control  everyday, reversible actions (playback, likes, playlists)
#   manage   administration: scans, imports, configuration, lifecycle
#
# Grants may use "*" for the area ("*.read"). Nothing grants everything by
# default, and no mode or flag widens a grant: what a surface may do is
# decided only by grants_for() in runner.py.

READ = "read"
CONTROL = "control"
MANAGE = "manage"


def permitted(granted, required: str) -> bool:
    if not required:
        return True
    area, _, level = required.partition(".")
    return required in granted or f"*.{level}" in granted or f"{area}.*" in granted


# ---------- arguments ----------

def _control_free(value: str) -> str:
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("control characters are not allowed")
    return value


@dataclass(frozen=True)
class Argument:
    """A positional argument. `variadic` takes every remaining positional."""

    name: str
    help: str = ""
    type: Callable[[str], Any] = str
    required: bool = True
    variadic: bool = False
    choices: tuple = ()
    sensitive: bool = False  # never written to the audit log

    def convert(self, raw: str):
        return _convert(self.name, self.type, self.choices, raw)

    @property
    def metavar(self) -> str:
        text = f"<{self.name}>" + ("..." if self.variadic else "")
        return text if self.required else f"[{text}]"


@dataclass(frozen=True)
class Option:
    """A --name option. A `flag` takes no value and is True when present."""

    name: str
    help: str = ""
    type: Callable[[str], Any] = str
    default: Any = None
    flag: bool = False
    choices: tuple = ()
    metavar: str = "value"
    sensitive: bool = False

    @property
    def dest(self) -> str:
        return self.name.replace("-", "_")

    def convert(self, raw: str):
        return _convert(f"--{self.name}", self.type, self.choices, raw)

    @property
    def usage(self) -> str:
        return f"[--{self.name}]" if self.flag else f"[--{self.name} <{self.metavar}>]"


def _convert(label: str, kind, choices, raw: str):
    try:
        value = kind(_control_free(raw))
    except (TypeError, ValueError) as error:
        detail = str(error) or f"invalid value '{raw}'"
        raise UsageError(f"{label}: {detail}")
    if choices and value not in choices:
        raise UsageError(f"{label} must be one of {', '.join(map(str, choices))}")
    return value


def bounded(low: int, high: int):
    """An int type that refuses anything outside [low, high]."""
    def parse(raw: str) -> int:
        try:
            number = int(raw)
        except ValueError:
            raise ValueError(f"expected a whole number, got '{raw}'")
        if not low <= number <= high:
            raise ValueError(f"must be between {low} and {high}")
        return number
    parse.__name__ = "int"
    return parse


# ---------- commands ----------

@dataclass
class Result:
    """What a handler returns: structured data, plus optional ready-made text."""

    data: Any = None
    text: Optional[str] = None


@dataclass
class Command:
    name: str
    summary: str
    handler: Callable
    permission: str
    description: str = ""
    arguments: tuple = ()
    options: tuple = ()
    # state-changing commands are audited and are never reachable from a
    # remote console unless `remote` says so explicitly
    mutates: bool = False
    # a question to ask before running; non-interactive callers must pass --yes
    confirm: Optional[str] = None
    # may run from Mission Control / the mobile app's console
    remote: Optional[bool] = None
    # needs this process to be the running StarCore (its live services)
    requires_live: bool = False
    # audited even though it changes nothing
    sensitive: bool = False
    render: Optional[Callable[[Any], str]] = None
    examples: tuple = ()
    aliases: tuple = ()
    namespace: str = ""  # filled in at registration

    def __post_init__(self):
        if self.remote is None:
            self.remote = not self.mutates
        if self.remote and self.confirm:
            raise ValueError(f"command '{self.name}' asks for confirmation, so it cannot be remote")
        variadic = [argument for argument in self.arguments if argument.variadic]
        if variadic and self.arguments[-1] is not variadic[0]:
            raise ValueError(f"command '{self.name}': only the last argument may be variadic")

    @property
    def path(self) -> str:
        return f"{self.namespace} {self.name}".strip()

    @property
    def usage(self) -> str:
        parts = [self.path] + [argument.metavar for argument in self.arguments]
        parts += [option.usage for option in self.options]
        return " ".join(parts)

    def schema(self) -> dict:
        """A JSON-ready description - what `help --json` and /api/commands
        publish, and what an automated client would read to call it."""
        return {
            "command": self.path,
            "namespace": self.namespace,
            "name": self.name,
            "summary": self.summary,
            "description": self.description or self.summary,
            "usage": self.usage,
            "permission": self.permission,
            "read_only": not self.mutates,
            "confirmation": bool(self.confirm),
            "remote": bool(self.remote),
            "requires_running_engine": self.requires_live,
            "arguments": [{"name": argument.name, "help": argument.help, "required": argument.required,
                           "variadic": argument.variadic, "type": _type_name(argument.type),
                           "choices": list(argument.choices)} for argument in self.arguments],
            "options": [{"name": f"--{option.name}", "help": option.help, "flag": option.flag,
                         "type": "flag" if option.flag else _type_name(option.type),
                         "default": option.default, "choices": list(option.choices)}
                        for option in self.options],
            "examples": list(self.examples),
        }


def _type_name(kind) -> str:
    return {str: "string", int: "int", float: "number"}.get(kind, getattr(kind, "__name__", "string"))


@dataclass
class Namespace:
    name: str
    summary: str
    commands: dict = field(default_factory=dict)
    source: str = "core"
    default: Optional[str] = None  # run when only the namespace is given
    aliases: tuple = ()

    def add(self, command: Command):
        command.namespace = self.name
        for name in (command.name, *command.aliases):
            if name in self.commands:
                raise ValueError(f"'{self.name} {name}' is defined twice")
            self.commands[name] = command

    def get(self, name: str):
        return self.commands.get(name)

    def unique(self) -> list:
        seen, ordered = set(), []
        for command in self.commands.values():
            if id(command) not in seen:
                seen.add(id(command))
                ordered.append(command)
        return ordered


@dataclass
class Context:
    """Who is running a command, from where, and what they may do."""

    engine: Any
    surface: str  # "terminal", "local" (one-shot CLI) or "remote" (web/mobile console)
    permissions: frozenset
    actor: str
    user: Optional[str] = None  # the StarCore account the command acts for
    interactive: bool = False
    confirm: Optional[Callable[[str], bool]] = None
    assume_yes: bool = False
    json: bool = False

    @property
    def live(self) -> bool:
        return bool(getattr(self.engine, "_running", False))


def parse_arguments(command: Command, tokens: list) -> dict:
    """Turns tokens into {dest: value}. Never evaluates or expands anything:
    every value is a plain string handed to the argument's own type."""
    values = {option.dest: (False if option.flag else option.default) for option in command.options}
    options = {option.name: option for option in command.options}
    positionals = []
    tokens = list(tokens)
    only_positionals = False

    while tokens:
        token = tokens.pop(0)
        if not only_positionals and token == "--":
            only_positionals = True
            continue
        if not only_positionals and token.startswith("--"):
            name, has_value, inline = token[2:].partition("=")
            option = options.get(name)
            if option is None:
                raise UsageError(f"unknown option '--{name}' for '{command.path}'")
            if option.flag:
                if has_value:
                    raise UsageError(f"--{name} takes no value")
                values[option.dest] = True
                continue
            if not has_value:
                if not tokens:
                    raise UsageError(f"--{name} needs a value")
                inline = tokens.pop(0)
            values[option.dest] = option.convert(inline)
            continue
        if not only_positionals and token.startswith("-") and len(token) > 1 and not _number(token):
            raise UsageError(f"unknown option '{token}' for '{command.path}' (use -- before a value starting with '-')")
        positionals.append(token)

    for argument in command.arguments:
        if argument.variadic:
            items, positionals = positionals, []
            if argument.required and not items:
                raise UsageError(f"missing {argument.metavar}. Usage: {command.usage}")
            values[argument.name] = [argument.convert(item) for item in items]
        elif positionals:
            values[argument.name] = argument.convert(positionals.pop(0))
        elif argument.required:
            raise UsageError(f"missing {argument.metavar}. Usage: {command.usage}")
        else:
            values[argument.name] = None

    if positionals:
        raise UsageError(f"unexpected argument '{positionals[0]}'. Usage: {command.usage}")
    return values


def _number(token: str) -> bool:
    try:
        float(token)
        return True
    except ValueError:
        return False


def redacted(command: Command, values: dict) -> dict:
    """The parsed values with anything marked sensitive removed - what the audit log keeps."""
    hidden = {argument.name for argument in command.arguments if argument.sensitive}
    hidden |= {option.dest for option in command.options if option.sensitive}
    return {key: ("[redacted]" if key in hidden else value) for key, value in values.items()}

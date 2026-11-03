class CommandRegistry:
    """Every CLI entry point, keyed by its first word.

    An entry is either an older single-function command ("function" set) or
    a typed namespace ("namespace" set, a starcore.cli.spec.Namespace whose
    commands the runner dispatches). Both share the same name space, so a
    satellite still cannot shadow a core command or another satellite's.
    """

    def __init__(self):
        self.commands = {}
        self.aliases = {}

    def add(self, name, function, metadata, source="core", namespace=None):
        if name in self.commands or name in self.aliases:
            existing = self.commands.get(name) or self.commands.get(self.aliases.get(name), {})
            print(
                f"[WARNING]: command '{name}' from '{source}' conflicts with an already "
                f"registered command from '{existing.get('source', 'core')}'. Skipping."
            )
            return False

        self.commands[name] = {
            "function": function,
            "metadata": metadata,
            "source": source,
            "namespace": namespace,
        }
        return True

    def add_namespace(self, namespace, source="core"):
        """Registers a typed namespace (see starcore.cli.spec)."""
        namespace.source = source
        metadata = {
            "description": namespace.summary,
            "usage": f"{namespace.name} <command> [options]",
            "aliases": list(namespace.aliases),
            "category": namespace.name.title(),
            "examples": [f"help {namespace.name}"],
        }
        if not self.add(namespace.name, None, metadata, source=source, namespace=namespace):
            return
        for alias in namespace.aliases:
            if alias in self.commands or alias in self.aliases:
                print(f"[WARNING]: alias '{alias}' of '{namespace.name}' is already taken. Skipping it.")
                continue
            self.aliases[alias] = namespace.name

    def get(self, name):
        return self.commands.get(name) or self.commands.get(self.aliases.get(name))

    def all(self):
        return self.commands

    def remove_source(self, source):
        """Drops every command registered by one source (a satellite's name).

        add() refuses to overwrite an existing command name rather than
        silently replacing it, so a satellite's stale commands have to be
        cleared out this way before it is reloaded - otherwise reload would
        keep serving the old command and just warn about the "conflict".
        """
        for name in [name for name, entry in self.commands.items() if entry["source"] == source]:
            del self.commands[name]
        for alias in [alias for alias, target in self.aliases.items() if target not in self.commands]:
            del self.aliases[alias]

class CommandRegistry:
    def __init__(self):
        self.commands = {}

    def add(self, name, function, metadata, source="core"):
        if name in self.commands:
            existing_source = self.commands[name]["source"]
            print(
                f"[WARNING]: command '{name}' from '{source}' conflicts with an already "
                f"registered command from '{existing_source}'. Skipping."
            )
            return

        self.commands[name] = {
            "function": function,
            "metadata": metadata,
            "source": source
        }

    def get(self, name):
        return self.commands.get(name)

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
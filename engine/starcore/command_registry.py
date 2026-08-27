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
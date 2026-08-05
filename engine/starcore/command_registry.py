class CommandRegistry:
    def __init__(self):
        self.commands = {}
        
    def add(self, name, function, metadata):
        self.commands[name] = {
            "function": function,
            "metadata": metadata
        }

    def get(self, name):
        return self.commands.get(name)

    def all(self):
        return self.commands
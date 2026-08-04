class CommandRegistry:
    def __init__(self):
        self.commands = {}
        
    def add(self, name, command):
        self.commands[name] = command

    def get(self, name):
        return self.commands.get(name)

    def all(self):
        return self.commands
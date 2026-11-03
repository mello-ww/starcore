COMMAND = {
    "description": "Say hello.",
    "usage": "hello",
    "category": "Core",
    "read_only": True,
}


def hello(engine, args):
    return "Hello from StarCore!"

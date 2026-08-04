import sys

from ..core import StarCore

def main():
    engine = StarCore()
    engine.start()

    print()
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║                        StarCore CLI                          ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print("Type 'help' for available commands.")
    print("Type 'exit' to quit.")
    print()

    while True:
        command = input("> ")
        if not command:
            continue
        if command == "exit":
            break
        result = engine.execute_command(command)
        if result is not None:
            print(result)

    engine.stop()

if __name__ == "__main__":
    main()


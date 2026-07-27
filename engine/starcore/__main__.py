import time
from .core import StarCore

def main() -> None:
    engine = StarCore()
    engine.start()
    time.sleep(3)  # Delay for 3 seconds
    engine.stop()

if __name__ == "__main__":
    main()
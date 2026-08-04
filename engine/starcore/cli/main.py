import sys

from .parser import parse

def main():
    command = sys.argv[1]
    result = parse(command)
    print(result)

if __name__ == "__main__":
    main()


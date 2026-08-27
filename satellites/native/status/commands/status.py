COMMAND = {
    "description": "Display the current status of the StarCore Core.",
    "usage": "status",
    "aliases": [],
    "category": "Status",
    "examples": [
        "status"
    ]
}

def status(engine, args):
    if args:
        print("[ERROR]: Usage: status")
        return

    core_status = engine.status()
    satellites = core_status["satellites"]

    print("StarCore status\n")
    print(f"Engine       {core_status['engine']}")
    print(f"State        {'running' if core_status['running'] else 'stopped'}")
    print(f"Satellites   {satellites['total']} (native: {satellites['native']}, link: {satellites['link']})")
    print(f"Commands     {core_status['commands']}")

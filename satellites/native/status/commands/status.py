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
    mission_control = core_status["mission_control"]

    print("StarCore status\n")
    print(f"Engine           {core_status['engine']}")
    print(f"State            {'running' if core_status['running'] else 'stopped'}")
    print(f"Uptime           {core_status['uptime_seconds']}s")
    print(f"Satellites       {satellites['total']} (native: {satellites['native']}, link: {satellites['link']})")
    print(f"Commands         {core_status['commands']}")
    print(f"Mission Control  {mission_control['url'] if mission_control['running'] else 'not running'}")

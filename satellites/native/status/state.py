import platform


def state(engine, satellite):
    return {
        "refresh_rate": satellite.config.get("refresh_rate"),
        "platform": platform.system(),
        "python": platform.python_version(),
    }

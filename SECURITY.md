# Security policy

StarCore guards personal data: photos, files, a locked folder. Reports of security problems
are taken seriously and are welcome.

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | yes |
| 0.1.0-alpha.1 | no |

## Reporting a vulnerability

Please report it privately, not in a public issue:

1. Open the repository's **Security** tab on GitHub.
2. Choose **Report a vulnerability** and describe what you found.

Useful to include: the version and commit (Mission Control: Configuration > About, "Copy
build info"; the Android app: Settings > About), how StarCore is deployed (directly, behind a
reverse proxy, in Docker), the steps to reproduce, and what an attacker gains.

StarCore is maintained by one person in their spare time, so answers are best-effort: usually
within a week or two.

## Scope

In scope: the Engine and its API, authentication and sessions, every first-party Satellite,
Mission Control, the Android app, and the deployment files in `deploy/`.

Out of scope: problems that need an already signed-in administrator to attack themselves,
a deployment exposed to the internet without HTTPS against the
[deployment guide](docs/guide/deployment.md)'s advice, and vulnerabilities in third-party
dependencies without a demonstrated impact on StarCore (report those upstream).

## What is already documented

The results of each security review and the limitations accepted for now are in the
[Roadmap](docs/project/roadmap.md) and, for the Locked Folder, in
[its documentation](docs/satellites/locked_folder.md). A known, documented limitation is
still worth reporting if you found a way to make it worse than described.

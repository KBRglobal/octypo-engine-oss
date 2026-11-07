# Security

## Reporting a vulnerability

Please report vulnerabilities through the
[private report form](https://github.com/KBRglobal/octypo-engine-oss/security/advisories/new),
not in a public issue. Include the steps to reproduce and the affected version.

Fixes are made on the latest release.

## Running Octypo safely

- Keep `.env` out of version control.
- Set a strong `ADMIN_PASSWORD` before exposing the admin panel to a network.
- Set `OCTYPO_DAILY_COST_CAP_USD` to limit daily model spend.

# Security Policy

## Supported versions

Security fixes are applied to the latest main branch.

## Reporting a vulnerability

Please do NOT open public issues for security vulnerabilities.

Send details privately to project maintainers with:

- affected component
- reproduction steps
- impact assessment
- suggested mitigation (optional)

## Secret management

- Never commit real API keys
- Keep `.env.local` local-only
- Rotate keys if exposed

## Hardening checklist

- Disable debug endpoints in production
- Restrict admin endpoints by network/auth
- Isolate DB/Redis from public internet

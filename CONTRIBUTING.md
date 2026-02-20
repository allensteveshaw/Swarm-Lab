# Contributing

Thanks for contributing to Swarm Lab.

## Setup

1. Fork and clone repository
2. Start dependencies:

```bash
cd backend
docker compose up -d
npm install
npm run dev:win
```

3. Init DB:

```bash
curl -X POST http://127.0.0.1:3017/api/admin/init-db
```

## Branch and PR

- Create feature branch: `feat/<name>` or `fix/<name>`
- Keep commits focused and clear
- Add tests if behavior changes
- Open PR with:
  - problem statement
  - solution summary
  - screenshots / logs if UI changed

## Code style

- TypeScript strict-friendly
- Do not commit secrets
- Avoid destructive migration unless necessary

## Issue labels (recommended)

- `bug`
- `enhancement`
- `documentation`
- `question`
- `good first issue`

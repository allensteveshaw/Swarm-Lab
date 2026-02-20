# Docker Requirements and Usage

## Required images

- `postgres:17-alpine`
- `redis:7-alpine`

## Start containers

```bash
cd backend
docker compose up -d
```

## Check status

```bash
docker compose ps
```

## Stop

```bash
docker compose down
```

## Recreate from clean state

```bash
docker compose down -v
docker compose up -d
```

## After startup

Initialize DB:

```bash
curl -X POST http://127.0.0.1:3017/api/admin/init-db
```

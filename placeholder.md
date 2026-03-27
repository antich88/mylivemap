# Render deployment checklist

1. Create Render web service bound to this repo (`mylivemap-web`).
2. Provision free Render Postgres (`mylivemap-db`).
3. Configure environment variables based on `.env.example`.
4. Deploy branch `main` — Render uses `render.yaml` for build commands.

## Auth-focused env checklist (local + Render)

1. `SECRET_KEY` must be explicitly set (do not use default from `.env.example`).
2. For local JSON mode set `APP_MODE=local` and ensure `data/users.json` is writable.
3. For SQL mode set `APP_MODE=sqlalchemy` and valid `DATABASE_URL`.
4. On Render keep `APP_MODE=sqlalchemy` and use managed Postgres `DATABASE_URL`.
5. After env changes, restart service and verify `/health`, then test `/register` and `/login`.

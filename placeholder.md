# Render deployment checklist

1. Create Render web service bound to this repo (`mylivemap-web`).
2. Provision free Render Postgres (`mylivemap-db`).
3. Configure environment variables based on `.env.example`.
4. Deploy branch `main` — Render uses `render.yaml` for build commands.

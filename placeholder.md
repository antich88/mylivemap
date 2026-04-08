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

## Render-specific reminders

1. [`render.yaml`](render.yaml) настраивает `live-map-web` c `gunicorn app:app`, сборка происходит через `pip install -r requirements.txt`, а ветка `main` деплоится автоматически.
2. `gunicorn` уже входит в [`requirements.txt`](requirements.txt), что гарантирует production-сервер.
3. `DATABASE_URL` и `SECRET_KEY` подставляются Render через env-vars; не пытайтесь хранить их в репозитории (`SECRET_KEY` уже требуется из окружения в [`config.py`](config.py)).
4. Flask отдает статические файлы из `static/` (см. `Flask(... static_folder="static" ...)` в [`app.py`](app.py:74)), поэтому просто держите директорию актуальной — Render отдаст её через gunicorn без дополнительной настройки.

# Сборка Partnerium CRM из форка

Источник: `git@github.com:3ragency/partnerium-crm.git`, рабочая ветка `partnerium`.
База ветки — официальный тег `twenty/v2.50.0`, совпадающий с установленной CRM.
`main` оставлен без изменений; перенос нового upstream-релиза в production — отдельное обновление с проверкой миграций.

## Coolify

Проект **Partnerium CRM**, production, сервер **partnerium nl** (`partnerium.app`).
Build pack: **Docker Compose**. Base directory: `/`. Compose location:
`/deploy/partnerium/docker-compose.yml`.

Включены **Raw Compose Deployment** и **Include Source Commit in Build**.
Выключено автоматическое добавление build args в Dockerfile. Секреты
`PG_DATABASE_PASSWORD`, `ENCRYPTION_KEY`, `APP_SECRET` и `SERVER_URL` задаются
в Coolify как runtime variables, без build-time доступа и без коммита в Git.
Build-time Compose допускает пустые runtime-секреты только для разбора файла;
перед включением production все четыре значения должны быть заполнены.

Docker собирается штатным `packages/twenty-docker/twenty/Dockerfile`, target
**twenty** (сервер и frontend). Последний target upstream Dockerfile — dev-образ,
поэтому полагаться на target по умолчанию нельзя. Один собранный образ
`partnerium-crm:<SOURCE_COMMIT>` используют и server, и worker.

Сборку запускает Coolify на сервере исполнения: Docker Compose не поддерживает
его отдельный build server. Контроллер Coolify сам приложение не собирает.
Сборка выполняется до остановки текущих контейнеров; во время переключения
возможна пауза, пока сервер завершает запуск и миграции.

## Данные

Compose предназначен только для существующего production. PostgreSQL, файлы
и Redis используют явно объявленные внешние тома текущей CRM. Если том
отсутствует, запуск должен завершиться ошибкой, а не создать пустую базу.
Нельзя запускать одновременно старую и новую базу на одном томе.
Для staging нужны другие домен, тома и секреты; этот файл нельзя повторно
использовать как staging без этих изменений.

Порты PostgreSQL/Redis наружу не публикуются. Traefik уже работает на сервере;
к сети `coolify` подключён только HTTP-сервер CRM.

## Процесс доработки

1. Создать `feature/<задача>` от `partnerium`.
2. Сделать доработку и необходимые проверки; схему и данные проверять отдельно.
3. Merge через PR в `partnerium`.
4. Coolify получает commit из этой ветки, собирает новый image и разворачивает его.
5. Проверить `/healthz`, worker, вход и авторизованную загрузку метаданных дашборда.

Для проверки метаданных на сервере:

```sh
python3 /opt/partnerium-crm/repository/scripts/check-metadata.py
```

После смены пароля владельца передавайте актуальные `CRM_SMOKE_EMAIL` и
`CRM_SMOKE_PASSWORD` через защищённое окружение. Проверка не меняет данные.
Для русского языка используйте `ru-RU`, а не `ru`.

## Обновление и откат

Перед изменением версии Twenty — резервная копия PostgreSQL, файлов, Redis,
секретов и рабочего Compose. Миграции выполняет только server; worker их не
запускает. Смена Docker image назад не откатывает данные и миграции.

Локальные бэкапы: `/opt/partnerium-crm/backups`, systemd timer
`partnerium-crm-backup.timer`. Они требуют отдельного внешнего хранилища для
защиты от потери сервера. Не коммитить `.env`, дампы, пароли или ключи.

Ручная сборка из корня репозитория при заполненном безопасном окружении:

```sh
docker compose --project-directory . -f deploy/partnerium/docker-compose.yml build server
```

Первое переключение со старого сервиса выполняется после успешной сборки:
снимок данных, остановка старых writers и базы, затем запуск нового Compose
на тех же томах. Автодеплой включается после успешной проверки первого запуска.

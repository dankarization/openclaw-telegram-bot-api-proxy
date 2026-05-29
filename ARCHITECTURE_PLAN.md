# Архитектурный план прокси Telegram Bot API для OpenClaw

Документ фиксирует, что стоит унаследовать из двух выбранных репозиториев:

- [`tdlib/telegram-bot-api`](https://github.com/tdlib/telegram-bot-api), изученный коммит `01a3679`
- [`Olegt0rr/telegram-local`](https://github.com/Olegt0rr/telegram-local), изученный коммит `22c2bf5`

Цель: сохранить текущую модель `local-first`, но сделать ее более явной, воспроизводимой и безопасной для update-очередей.

## Целевая схема

```text
OpenClaw Gateway
  -> http://127.0.0.1:8082
  -> openclaw-telegram-bot-api-proxy
      primary  -> http://127.0.0.1:8081
                  Docker aiogram/telegram-bot-api:latest --local
      fallback -> https://api.telegram.org
```

Основное правило: локальный Bot API всегда первичен. Cloud используется только как аварийный канал для безопасных запросов и не должен молча откатывать OpenClaw на старые `update_id`.

## Что берем из tdlib/telegram-bot-api

### Local mode как обязательный контракт

В официальном README local mode описан как отдельный режим, который дает большие файлы, локальные пути и upload до 2000 MB:

- [`README.md#L54-L66`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/README.md#L54-L66)
- [`telegram-bot-api.cpp#L211-L228`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/telegram-bot-api.cpp#L211-L228)

Что наследуем:

- запуск Bot API только с `--local` / `TELEGRAM_LOCAL=1`;
- порт `8081` оставляем внутренним upstream;
- в документации прокси прямо пишем, что без `--local` архитектура теряет смысл;
- для Docker volume обязательно сохраняем `/var/lib/telegram-bot-api`.

### Владение токеном и миграции

Официальный README отдельно предупреждает: при переносе бота на локальный server нужно делать `logOut` на cloud, а при переносе между локальными серверами нельзя держать один token в нескольких Bot API инстансах без аккуратного перехода:

- [`README.md#L79-L93`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/README.md#L79-L93)
- [`Client.cpp#L12641-L12651`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L12641-L12651)

Что наследуем:

- отдельный runbook `docs/token-migration.md`;
- диагностическую команду/секцию для проверки текущего владельца token: local/cloud;
- запрет на автоматический `logOut` из прокси;
- явную пометку cloud fallback как best-effort режима, потому что официальный server не обещает надежную доставку при одновременной жизни token на нескольких серверах.

### Persistent update queue

Server хранит очередь updates в `tqueue.binlog`, а webhook state в `webhooks_db.binlog`:

- [`ClientManager.cpp#L321-L360`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/ClientManager.cpp#L321-L360)

Что наследуем:

- Docker volume с данными Bot API нельзя удалять или пересоздавать без runbook;
- в плане миграции обязательно проверяем, что новый контейнер использует тот же volume или корректно закрыт старый instance;
- stale local updates считаем штатным риском после переезда, а не странной случайностью;
- текущая защита proxy, которая отбрасывает local updates ниже OpenClaw offset и делает `ack` через `getUpdates?offset=...&timeout=0`, остается обязательной.

### Семантика getUpdates

В официальной реализации:

- `getUpdates` конфликтует с активным webhook;
- одновременно допускается только один long poll;
- отрицательный `offset` очищает часть очереди;
- `offset <= 0` стартует с головы очереди;
- пустой long poll сохраняет `long_poll_offset_`.

Код:

- [`Client.cpp#L15700-L15712`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L15700-L15712)
- [`Client.cpp#L16225-L16235`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L16225-L16235)
- [`Client.cpp#L16321-L16420`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L16321-L16420)

Что наследуем:

- proxy не должен создавать конкурирующий long poll без нужды;
- cloud `getUpdates` разрешен только после local failure или после `local-empty + cloud-pending`;
- `ack-dropped` всегда с `timeout=0`;
- для cloud fallback нужен отдельный cursor, потому что cloud `update_id` и local `update_id` могут разойтись;
- виртуализация cloud `update_id` выше local offset остается правильной защитой от оживления старых сессий.

### Файлы и пути

В официальном server:

- cloud/non-local режим ограничивает `getFile` примерно 20 MiB;
- local mode возвращает absolute `file_path`;
- local mode принимает `file:/...` как input file path;
- для non-local server относительный `file_path` выдается только для файлов в лимите.

Код:

- [`Client.h#L70-L72`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.h#L70-L72)
- [`Client.cpp#L15814-L15823`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L15814-L15823)
- [`Client.cpp#L16675-L16688`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L16675-L16688)
- [`Client.cpp#L10016-L10037`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L10016-L10037)

Что наследуем:

- `/file/...` fallback в cloud только если размер известен и не выше cloud-лимита;
- неизвестный размер не fallback-ится;
- тяжелые файлы всегда остаются local-only;
- `LOCAL_FILE_PATH_REWRITE_FROM` и `LOCAL_FILE_PATH_REWRITE_TO` превращаем в документированный обязательный параметр для Docker local mode, если OpenClaw читает файл напрямую;
- для upload не буферизуем multipart и не fallback-им в cloud.

### Встроенная статистика и лимиты

Server считает активные запросы и active file uploads, а в non-local режиме применяет flood/upload ограничения:

- [`Stats.h#L181-L217`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Stats.h#L181-L217)
- [`Client.cpp#L7963-L7985`](https://github.com/tdlib/telegram-bot-api/blob/01a3679/telegram-bot-api/Client.cpp#L7963-L7985)

Что наследуем:

- в proxy добавляем легкие счетчики `target=local/cloud`, `method`, `status`, `ms`, `fallback reason`;
- отдельно логируем active streaming uploads/downloads;
- не добавляем тяжелую metrics-систему на первом шаге, достаточно структурированных daily logs.

## Что берем из Olegt0rr/telegram-local

### Docker topology

Пример держит `aiogram/telegram-bot-api:latest` отдельным service и шарит volume `/var/lib/telegram-bot-api` с reverse proxy:

- [`docker-compose.yml#L3-L33`](https://github.com/Olegt0rr/telegram-local/blob/22c2bf5/docker-compose.yml#L3-L33)
- [`examples/example.env#L6-L10`](https://github.com/Olegt0rr/telegram-local/blob/22c2bf5/examples/example.env#L6-L10)

Что наследуем:

- `docker-compose.example.yml` для нашего repo;
- service `telegram-bot-api` на image `aiogram/telegram-bot-api:latest`;
- persistent volume `telegram-bot-api-data:/var/lib/telegram-bot-api`;
- наружу публикуем только `127.0.0.1:8081`, либо держим Bot API внутри Docker network, если proxy тоже будет контейнером;
- env template с `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_LOCAL=1`.

### Reverse proxy детали

Nginx пример дает несколько полезных настроек:

- `client_max_body_size 2G`;
- proxy timeouts по 600 секунд;
- token-safe access log;
- `/file/bot...` умеет отдавать файлы из shared volume;
- backend Bot API не светится наружу.

Код:

- [`nginx/default.conf#L1-L55`](https://github.com/Olegt0rr/telegram-local/blob/22c2bf5/nginx/default.conf#L1-L55)

Что наследуем:

- token masking для логов proxy;
- большие timeout/body-size как ориентир для streaming path;
- опциональный static-file режим для `/file/...` через shared volume, если понадобится разгрузить Node proxy;
- backend local Bot API остается непубличным.

Что не наследуем:

- nginx как обязательный слой: наш Node proxy уже принимает решения local/cloud и понимает Telegram offsets;
- webhook-first схему для OpenClaw: OpenClaw сейчас работает через `getUpdates`, а именно там нужен offset guard.

### Клиентская настройка local API

В примере aiogram bot явно использует custom API server с `is_local=True`:

- [`app/__init__.py#L25-L31`](https://github.com/Olegt0rr/telegram-local/blob/22c2bf5/app/__init__.py#L25-L31)

Что наследуем:

- в README фиксируем, что OpenClaw должен смотреть не на `api.telegram.org`, а на proxy `http://127.0.0.1:8082`;
- proxy, а не OpenClaw, решает, когда можно уйти в cloud fallback.

## План работ

### ~~Этап 1. Документация и воспроизводимость~~

- ~~Добавить `docker-compose.example.yml`.~~
- ~~Добавить `.env.example` для Bot API и proxy.~~
- ~~Добавить `docs/token-migration.md`.~~
- ~~Добавить `docs/operations.md` с командами проверки local/cloud ownership, очереди и логов.~~
- ~~Обновить README короткой схемой: OpenClaw -> proxy -> local Bot API -> cloud fallback.~~

### Этап 2. Укрепление proxy

- ~~Маскировать bot token в логах.~~
- ~~Добавить счетчики active streaming requests.~~
- ~~Вынести fallback-policy в именованные группы и правила:~~
  - ~~`localAdminMethods`: `getMe`, `getUpdates`, `getWebhookInfo`, `deleteWebhook`;~~
  - ~~`safeCloudFallbackMethods`: методы без тяжелых файловых тел;~~
  - ~~`localOnlyMethods` и dynamic local-only причины: token/webhook ownership methods, multipart upload, тяжелый `/file`, неизвестный file size.~~
- ~~Оставить cloud `getUpdates` только через текущий guarded path.~~
- ~~Явно логировать `cloud-pending-probe`, `virtualized-update-id`, `dropped-local-update`, `ack-dropped`.~~

### Этап 3. Docker local Bot API

- Зафиксировать image `aiogram/telegram-bot-api:latest`.
- Зафиксировать volume `/var/lib/telegram-bot-api`.
- Решить, proxy остается systemd-сервисом или тоже уходит в compose:
  - ближний путь: Bot API в Docker, proxy в user systemd;
  - следующий путь: Bot API и proxy в одном compose, наружу только proxy на `127.0.0.1:8082`.
- Для WSL/VM101 отдельно описать host path для `LOCAL_FILE_PATH_REWRITE_TO`.

### Этап 4. Проверки и аварийные сценарии

- Smoke test:
  - `getMe` через proxy;
  - `getUpdates` при пустой local очереди;
  - маленькое фото через `getFile` и `/file`;
  - файл больше cloud лимита через local only;
  - local down -> cloud text command fallback.
- Stale update test:
  - искусственно подать local update ниже OpenClaw offset;
  - убедиться, что proxy его отбрасывает и делает `ack-dropped`;
  - убедиться, что OpenClaw не оживляет старую сессию.
- Migration test:
  - старый local server закрыт;
  - новый server использует корректный volume;
  - cloud fallback не начинает читать старую cloud очередь без virtual offset.

## Риски

- Cloud fallback противоречит идеальной модели Telegram "один token - один Bot API server", поэтому это должен быть осознанный аварийный режим.
- Если удалить Docker volume, local server может потерять контекст и снова принести старые/разъехавшиеся updates.
- Если OpenClaw получает absolute `file_path` из контейнера без rewrite, медиа может ломаться даже при здоровом local Bot API.
- Если proxy начнет fallback-ить multipart/upload в cloud, большие файлы будут ломаться и могут создавать дубли side effects.

## Решение по умолчанию

Дальше развиваем текущий proxy, а не заменяем его nginx:

- `tdlib/telegram-bot-api` дает правила и ограничения;
- `Olegt0rr/telegram-local` дает Docker packaging и reverse proxy практики;
- наш proxy остается местом, где живет Telegram-specific fallback logic: offset floor, cloud cursor, stale update guard и file-size-aware `/file` fallback.

# OpenClaw Telegram Bot API Proxy

Proxy для OpenClaw: локальный Telegram Bot API в приоритете, cloud Bot API только как аварийный fallback.
Он защищает pipeline от расхождения local/cloud Bot API `update_id`, чтобы
fallback не смешивал разные пространства updates и не ломал выбор voice/media
файлов.

## Схема

```text
OpenClaw Gateway
  -> http://127.0.0.1:8082
  -> openclaw-telegram-bot-api-proxy
      primary  -> http://127.0.0.1:8081
                  Docker aiogram/telegram-bot-api:latest --local
      fallback -> https://api.telegram.org
```

## Поведение

- Локальный Bot API всегда в приоритете.
- Local `getUpdates` перед fallback ретраится несколько раз; краткий обрыв
  HTTP-соединения не должен валить Telegram provider.
- Длительность long poll для local `getUpdates` ограничивается
  `LOCAL_GETUPDATES_TIMEOUT_SECONDS`; значение `0` отключает long poll и
  превращает его в short polling.
- Cloud fallback включается при ошибке local API после retry или когда local
  `getUpdates` пустой, но в cloud есть свежие pending updates.
- Если local API здоров и просто возвращает пустой `getUpdates`, cloud pending
  fallback откладывается минимум на `CLOUD_PENDING_FALLBACK_DELAY_MS`: краткий
  лаг local Bot API не должен сразу переводить pipeline в cloud.
- `getUpdates` защищён от старых cloud updates:
  - proxy читает локальный OpenClaw offset;
  - ведёт отдельный cloud cursor;
  - при необходимости поднимает cloud `update_id` выше локального offset.
- После cloud fallback local `update_id` мостится в виртуальную шкалу над
  OpenClaw offset, если local и cloud id явно разъехались. Это снижает риск
  смешать local/cloud update spaces и выбрать не тот voice/media file.
- Старые local updates ниже OpenClaw offset отбрасываются и подтверждаются в
  local Bot API, чтобы они не возвращались снова.
- `getFile` при local `400` повторяется через cloud: это покрывает file_id,
  полученные из cloud fallback, которые локальный Bot API ещё не знает.
- `/file/...` уходит в cloud только если размер известен из `getFile` и не
  больше `CLOUD_FILE_FALLBACK_MAX_BYTES`.
- Файлы неизвестного размера и тяжёлые файлы остаются только на local API.
- Отправка файлов через `multipart/form-data`, где в HTTP-запросе идут сами
  байты файла, не fallback-ится в cloud: такой stream нельзя безопасно
  повторить, а cloud Bot API не рассчитан на наши большие local-файлы.

## Требования

- Node.js 22+
- Docker-контейнер `aiogram/telegram-bot-api:latest` на `127.0.0.1:8081`
- Docker Compose v2 для `docker-compose.example.yml`
- OpenClaw Telegram `apiRoot`: `http://127.0.0.1:8082`

## Быстрый старт

```bash
cp .env.example .env
docker compose -f docker-compose.example.yml --env-file .env up -d telegram-bot-api
npm run check
ENABLE_CLOUD_FALLBACK=1 node src/telegram-bot-api-proxy.mjs
```

Для постоянного запуска proxy используется user systemd unit:

```text
systemd/openclaw-telegram-api-proxy.service.example
```

## Переменные окружения

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | Хост proxy. |
| `PORT` | `8082` | Порт proxy. |
| `LOCAL_API_ROOT` | `http://127.0.0.1:8081` | Локальный Docker Bot API. |
| `CLOUD_API_ROOT` | `https://api.telegram.org` | Cloud Bot API. |
| `ENABLE_CLOUD_FALLBACK` | `false` | Включить cloud fallback. |
| `TELEGRAM_OFFSET_DIR` | `telegram` | Каталог OpenClaw offset-файлов. |
| `CLOUD_FILE_FALLBACK_MAX_BYTES` | `20971520` | Лимит размера файла для cloud `/file/...`. |
| `LOCAL_FILE_PATH_REWRITE_FROM` | пусто | Контейнерный префикс file_path из local Bot API. |
| `LOCAL_FILE_PATH_REWRITE_TO` | пусто | Host-префикс того же Docker volume для OpenClaw. |
| `BUFFER_LIMIT_BYTES` | `8388608` | Лимит буферизации API-запроса. |
| `LOCAL_HEALTH_TTL_MS` | `5000` | TTL успешной проверки local API. |
| `LOCAL_UNHEALTHY_COOLDOWN_MS` | `5000` | Пауза после ошибки local API. |
| `LOCAL_HEALTH_TIMEOUT_MS` | `2000` | Таймаут health-check через `getMe`. |
| `UPSTREAM_TIMEOUT_MS` | `130000` | Таймаут upstream-запроса. |
| `ENABLE_CLOUD_GETUPDATES_FALLBACK` | `true` | Разрешить cloud fallback для `getUpdates` после local retry. |
| `LOCAL_GETUPDATES_TIMEOUT_SECONDS` | `10` | Максимальный `timeout` для local `getUpdates`; `0` отключает long poll. |
| `LOCAL_GETUPDATES_MAX_ATTEMPTS` | `4` | Количество local-попыток `getUpdates` перед fallback/ошибкой. |
| `LOCAL_GETUPDATES_RETRY_BASE_MS` | `300` | Базовая пауза между retry; растёт экспоненциально. |
| `LOCAL_GETUPDATES_UPSTREAM_TIMEOUT_MS` | `15000` | Сетевой timeout одного local `getUpdates` запроса. |
| `CLOUD_PENDING_PROBE_TTL_MS` | `5000` | TTL проверки cloud pending updates. |
| `CLOUD_PENDING_FALLBACK_DELAY_MS` | `60000` | Минимальный возраст cloud pending backlog перед fallback, когда local API здоров и возвращает пустой `getUpdates`. |
| `CLOUD_FRESH_UPDATE_MAX_AGE_MS` | `21600000` | Максимальный возраст cloud update для виртуального подъёма id. |
| `LOCAL_VIRTUAL_OFFSET_SKEW_MIN` | `1000000` | Минимальный разрыв между OpenClaw offset и local `update_id`, при котором proxy считает id разными пространствами и мостит local updates в виртуальную шкалу. |

## OpenClaw

В `openclaw.json` Telegram-аккаунт должен смотреть на proxy:

```json
{
  "apiRoot": "http://127.0.0.1:8082"
}
```

Proxy использует offset-файлы OpenClaw:

```text
telegram/update-offset-default.json
telegram/update-offset-syncopia-guest-bot.json
```

В файлах нужны `botId` и `lastUpdateId`.

## Документация

- [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) - архитектурный план.
- [docs/token-migration.md](docs/token-migration.md) - переезд token между cloud/local/local.
- [docs/operations.md](docs/operations.md) - проверки сервисов, очереди, offset-файлов и логов.

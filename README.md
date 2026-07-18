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
- Cloud fallback для `getUpdates` рассматривается только после сетевой ошибки,
  timeout или HTTP 5xx от local API после retry. Если native cloud cursor ещё
  неизвестен, proxy возвращает local-ошибку и не трогает cloud queue: высокий
  virtual offset удалил бы lower-ID backlog, а автоматический `offset=0` не
  отличает зеркальные local-дубли от ещё не обработанных updates.
- Успешный пустой local `getUpdates` возвращается как есть и по умолчанию даже
  не запускает cloud pending probe. Аварийный rescue старого cloud backlog
  доступен только через явный `ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY=1`.
- При включённом empty-local rescue cloud pending fallback откладывается минимум
  на `CLOUD_PENDING_FALLBACK_DELAY_MS`. Этот opt-in также может инициализировать
  RAM-only cloud cursor; оператор принимает best-effort риск cross-source dedup.
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
- Успешный `getFile` на время `FILE_INFO_CACHE_TTL_MS` связывает `file_path`
  с его upstream: local path скачивается через local, cloud path через cloud.
- Cloud `/file/...` разрешён только если размер известен из `getFile` и не
  больше `CLOUD_FILE_FALLBACK_MAX_BYTES`; лимит важнее source affinity.
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
| `TELEGRAM_OFFSET_DIR` | `telegram` | Каталог legacy OpenClaw offset-файлов; новые OpenClaw могут хранить offset в SQLite. |
| `CLOUD_FILE_FALLBACK_MAX_BYTES` | `20971520` | Лимит размера файла для cloud `/file/...`. |
| `FILE_INFO_CACHE_TTL_MS` | `300000` | TTL bot-scoped связи `file_path` с local/cloud источником `getFile`. |
| `LOCAL_FILE_PATH_REWRITE_FROM` | пусто | Контейнерный префикс file_path из local Bot API. |
| `LOCAL_FILE_PATH_REWRITE_TO` | пусто | Host-префикс того же Docker volume для OpenClaw. |
| `BUFFER_LIMIT_BYTES` | `8388608` | Лимит буферизации API-запроса. |
| `LOCAL_HEALTH_TTL_MS` | `5000` | TTL успешной проверки local API. |
| `LOCAL_UNHEALTHY_COOLDOWN_MS` | `5000` | Пауза после ошибки local API. |
| `LOCAL_HEALTH_TIMEOUT_MS` | `2000` | Таймаут health-check через `getMe`. |
| `UPSTREAM_TIMEOUT_MS` | `130000` | Таймаут upstream-запроса. |
| `ENABLE_CLOUD_GETUPDATES_FALLBACK` | `true` | Разрешить cloud fallback для `getUpdates` после local retry. |
| `ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY` | `false` | Явно разрешить cloud pending rescue после успешного пустого local `getUpdates`. |
| `LOCAL_GETUPDATES_TIMEOUT_SECONDS` | `10` | Максимальный `timeout` для local `getUpdates`; `0` отключает long poll. |
| `LOCAL_GETUPDATES_MAX_ATTEMPTS` | `4` | Количество local-попыток `getUpdates` перед fallback/ошибкой. |
| `LOCAL_GETUPDATES_RETRY_BASE_MS` | `300` | Базовая пауза между retry; растёт экспоненциально. |
| `LOCAL_GETUPDATES_UPSTREAM_TIMEOUT_MS` | `15000` | Сетевой timeout одного local `getUpdates` запроса. |
| `CLOUD_PENDING_PROBE_TTL_MS` | `5000` | TTL проверки cloud pending updates. |
| `CLOUD_PENDING_FALLBACK_DELAY_MS` | `60000` | Минимальный возраст cloud pending backlog для явно включённого empty-local rescue. |
| `CLOUD_FRESH_UPDATE_MAX_AGE_MS` | `21600000` | Максимальный возраст cloud update для виртуального подъёма id. |
| `LOCAL_VIRTUAL_OFFSET_SKEW_MIN` | `1000000` | Минимальный разрыв между OpenClaw offset и local `update_id`, при котором proxy считает id разными пространствами и мостит local updates в виртуальную шкалу. |
| `LOCAL_UPDATE_STATE_SEED` | пусто | Необязательные `botId:localFloor:virtualFloor` anchors через запятую для продолжения уже известного affine local bridge после restart; для нового anchor нужен durable high-water этого bot/account, а не отстающий ACK cursor. Значения не содержат token. |

## OpenClaw

В `openclaw.json` Telegram-аккаунт должен смотреть на proxy:

```json
{
  "apiRoot": "http://127.0.0.1:8082"
}
```

Старые версии OpenClaw использовали offset-файлы:

```text
telegram/update-offset-default.json
telegram/update-offset-syncopia-guest-bot.json
```

Текущие версии могут хранить ACK cursor в SQLite namespace
`telegram.update-offsets`, а уже принятые event IDs — в durable ingress spool.
ACK cursor может отставать от максимального когда-либо выданного virtual ID,
например после handler timeout.

При создании или перепривязке `LOCAL_UPDATE_STATE_SEED` берите одну парную
точку affine mapping:

- `localFloor` — максимальный native local update ID, уже подтверждённый этим
  bridge upstream; pending/unconsumed update сюда включать нельзя;
- `virtualFloor` — high-water уже выданных/записанных virtual IDs именно этого
  bot/account, включая durable ingress spool, даже если persisted ACK cursor ниже.

Если взять `virtualFloor` из отстающего ACK cursor или только из RAM proxy,
новые updates могут получить уже существующие event IDs и будут дедуплицированы
до маршрутизации. Проверенный старый anchor остаётся валиден между restart при
монотонных local IDs и неизменном affine mapping; после cloud mapping или reset
native ID anchor нужно проверить заново.

## Документация

- [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) - архитектурный план.
- [docs/token-migration.md](docs/token-migration.md) - переезд token между cloud/local/local.
- [docs/operations.md](docs/operations.md) - проверки сервисов, очереди, durable high-water и логов.

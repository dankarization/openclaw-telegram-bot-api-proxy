# OpenClaw Telegram Bot API Proxy

Proxy для Telegram Bot API в OpenClaw с приоритетом локального сервера.

Он нужен для схемы, где основной канал работает через локальный
`telegram-bot-api` и умеет принимать тяжёлые файлы, но при падении локального
сервера связь с ботом не должна пропадать полностью. В аварийном режиме proxy
переключает безопасные запросы на облачный `api.telegram.org`, а тяжёлые файлы
оставляет на локальном сервере.

## Поведение

- Сначала отправляет запросы OpenClaw в локальный Telegram Bot API.
- При недоступности local API или выбранных безопасных ошибках использует
  Telegram cloud API.
- Защищает fallback для `getUpdates`: учитывает локальный offset и отдельный
  cloud cursor, чтобы старые облачные updates не откатывали offset OpenClaw.
- При необходимости переписывает cloud `update_id` в виртуальный монотонный
  диапазон выше локального offset.
- Разрешает cloud fallback для `/file/...` только когда размер файла уже известен
  из ответа `getFile` и не превышает `CLOUD_FILE_FALLBACK_MAX_BYTES`.
- Файлы неизвестного размера и большие файлы оставляет только на local API.

## Требования

- Node.js 22+
- Локальный Telegram Bot API server, например
  `aiogram/telegram-bot-api:latest`
- OpenClaw, настроенный использовать этот proxy как Telegram `apiRoot`

## Конфигурация

Переменные окружения:

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | Хост, на котором слушает proxy. |
| `PORT` | `8082` | Порт proxy. |
| `LOCAL_API_ROOT` | `http://127.0.0.1:8081` | Адрес локального Bot API. |
| `CLOUD_API_ROOT` | `https://api.telegram.org` | Адрес Telegram cloud API. |
| `ENABLE_CLOUD_FALLBACK` | `false` | Включает fallback в cloud. |
| `TELEGRAM_OFFSET_DIR` | `telegram` | Каталог с OpenClaw update-offset файлами. |
| `CLOUD_FILE_FALLBACK_MAX_BYTES` | `20971520` | Максимальный известный размер файла для cloud `/file/...` fallback. |
| `BUFFER_LIMIT_BYTES` | `8388608` | Максимальный размер буферизуемого API-запроса. |
| `LOCAL_HEALTH_TTL_MS` | `5000` | TTL успешной проверки local API. |
| `LOCAL_UNHEALTHY_COOLDOWN_MS` | `5000` | Пауза перед новой проверкой local API после ошибки. |
| `LOCAL_HEALTH_TIMEOUT_MS` | `2000` | Таймаут local health-check через `getMe`. |
| `UPSTREAM_TIMEOUT_MS` | `130000` | Таймаут запроса к upstream API. |

## Настройка OpenClaw

Укажите proxy как `apiRoot` Telegram-аккаунта:

```json
{
  "apiRoot": "http://127.0.0.1:8082"
}
```

Proxy читает OpenClaw offset-файлы такого вида:

```text
telegram/update-offset-default.json
telegram/update-offset-syncopia-guest-bot.json
```

В каждом файле должны быть `botId` и `lastUpdateId`.

## Локальная разработка

```bash
npm run check
ENABLE_CLOUD_FALLBACK=1 node src/telegram-bot-api-proxy.mjs
```

## systemd

Пример user-unit лежит в
`systemd/openclaw-telegram-api-proxy.service.example`.

# Миграция Telegram bot token

Этот runbook нужен для переезда token между cloud Bot API, локальным Docker Bot API и новым локальным сервером. Proxy сам не вызывает `logOut`, `close` или `deleteWebhook`: эти команды меняют владельца token и должны выполняться явно.

## Переменные

```bash
export BOT_TOKEN='123456:telegram-token'
export LOCAL_API='http://127.0.0.1:8081'
export PROXY_API='http://127.0.0.1:8082'
export CLOUD_API='https://api.telegram.org'
```

## Cloud -> local

Официальный путь Telegram: сначала вывести bot из cloud Bot API, потом переключить клиента на local.

```bash
curl -sS -X POST "$CLOUD_API/bot$BOT_TOKEN/logOut"
docker compose -f docker-compose.example.yml --env-file .env up -d telegram-bot-api
curl -sS "$LOCAL_API/bot$BOT_TOKEN/getMe"
curl -sS "$PROXY_API/bot$BOT_TOKEN/getMe"
```

После `logOut` cloud Bot API может быть недоступен для этого token около 10 минут. Cloud fallback в этот период не считается надежным каналом.

## Local -> local без потери очереди

Если нужно переехать с одного локального Bot API на другой и сохранить updates, не держим один token активным на двух local servers одновременно.

1. Остановить потребителя updates на время переезда.
2. На старом local server убрать webhook, если он был включен:

```bash
curl -sS -X POST "$OLD_LOCAL_API/bot$BOT_TOKEN/deleteWebhook"
```

3. Закрыть bot instance на старом local server:

```bash
curl -sS -X POST "$OLD_LOCAL_API/bot$BOT_TOKEN/close"
```

4. Перенести subdirectory bot из старого working directory в новый working directory. Для Docker setup это данные внутри `/var/lib/telegram-bot-api`.
5. Запустить новый local server и проверить:

```bash
curl -sS "$NEW_LOCAL_API/bot$BOT_TOKEN/getMe"
curl -sS "$NEW_LOCAL_API/bot$BOT_TOKEN/getWebhookInfo"
```

## Local -> cloud

Это аварийный возврат на официальный Bot API. Перед ним нужно понимать, что большие файлы и local file paths перестанут работать.

```bash
curl -sS -X POST "$LOCAL_API/bot$BOT_TOKEN/deleteWebhook"
curl -sS -X POST "$LOCAL_API/bot$BOT_TOKEN/logOut"
curl -sS "$CLOUD_API/bot$BOT_TOKEN/getMe"
```

## Проверка после переезда

```bash
curl -sS "$LOCAL_API/bot$BOT_TOKEN/getMe"
curl -sS "$PROXY_API/bot$BOT_TOKEN/getMe"
curl -sS "$LOCAL_API/bot$BOT_TOKEN/getWebhookInfo"
curl -sS "$CLOUD_API/bot$BOT_TOKEN/getWebhookInfo"
```

Ожидаемое состояние для основной схемы: local отвечает на `getMe`, proxy отвечает на `getMe`, OpenClaw смотрит на proxy, а Docker data directory не пересоздавался пустым.

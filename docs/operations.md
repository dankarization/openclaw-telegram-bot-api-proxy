# Операции

Команды ниже ничего не перезапускают и не чистят. Они нужны для проверки local/cloud ownership, очереди и логов.

## Переменные

```bash
export BOT_TOKEN='123456:telegram-token'
export LOCAL_API='http://127.0.0.1:8081'
export PROXY_API='http://127.0.0.1:8082'
export CLOUD_API='https://api.telegram.org'
```

## Сервисы

```bash
docker ps --filter ancestor=aiogram/telegram-bot-api:latest
systemctl --user status openclaw-telegram-api-proxy.service
```

## Local/proxy/cloud

```bash
curl -sS "$LOCAL_API/bot$BOT_TOKEN/getMe"
curl -sS "$PROXY_API/bot$BOT_TOKEN/getMe"
curl -sS "$CLOUD_API/bot$BOT_TOKEN/getMe"
```

Для основной схемы local и proxy должны отвечать `ok: true`. Cloud может временно отвечать ошибкой после `logOut`; это нормально для чистого local mode, но в такой момент cloud fallback не является надежным.

## Очередь updates

Безопасная проверка очереди:

```bash
curl -sS "$LOCAL_API/bot$BOT_TOKEN/getWebhookInfo"
curl -sS "$CLOUD_API/bot$BOT_TOKEN/getWebhookInfo"
```

Не дергать `getUpdates` вручную, пока OpenClaw работает: ручной long poll может получить `409 Conflict` или помешать основному polling loop. Если нужно разово посмотреть голову очереди, сначала остановить потребителя updates и использовать `timeout=0`.

```bash
curl -sS "$LOCAL_API/bot$BOT_TOKEN/getUpdates?timeout=0&limit=1"
```

## OpenClaw offsets

Proxy сверяет local updates с offset-файлами OpenClaw.

```bash
find telegram -maxdepth 1 -name 'update-offset-*.json' -print
sed -n '1,120p' telegram/update-offset-default.json
```

В offset-файле важны `botId` и `lastUpdateId`.

## Логи proxy

```bash
tail -n 200 logs/telegram-bot-api-proxy.log
journalctl --user -u openclaw-telegram-api-proxy.service -n 200 --no-pager
```

Важные маркеры:

- `target=local` - запрос ушел в локальный Bot API.
- `target=cloud` - запрос ушел в cloud fallback.
- `action=retry` - local `getUpdates` временно оборвался или вернул 5xx, proxy повторяет запрос перед fallback.
- `timeoutCapped=` - proxy снизил `getUpdates timeout` до `LOCAL_GETUPDATES_TIMEOUT_SECONDS`.
- `fallbackReason=local-unavailable` - network/timeout fallback; предварительный retry применяется к `getUpdates`.
- `fallbackReason=local-5xx` - HTTP 5xx fallback; предварительный retry применяется к `getUpdates`.
- `fallbackReason=cloud-cursor-uninitialized` - local действительно отказал, но proxy не стал делать cloud `getUpdates`: native cloud cursor неизвестен, поэтому любой автоматический bootstrap мог бы удалить backlog или выдать зеркальные дубли.
- `reason=local-empty-cloud-pending` - явно включённый empty-local rescue нашёл cloud pending updates.
- `action=cloud-pending-probe` - opt-in rescue проверил cloud backlog через `getWebhookInfo`.
- `action=virtualized-update-id` - cloud `update_id` поднят выше local offset.
- `action=ack-dropped` - proxy подтвердил старые local updates, чтобы они не вернулись снова.
- `action=fallback-blocked` - fallback запрещен политикой, например для `multipart/form-data`.
- `localUpdateStateSeeds=` - число проверенных local bridge anchors, загруженных при startup; production restart с уже разошедшимися ID-space должен показывать ожидаемое ненулевое значение.
- `cause=` - вложенная причина Node `fetch`/socket ошибки, если она есть.
- `dropped=` - proxy отфильтровал updates ниже OpenClaw offset.
- `translated=yes` - cloud `update_id` виртуально поднят выше local offset.
- `activeStreaming*=` - сколько streaming download/upload/passthrough сейчас идет через proxy.

## Проверка файлов

```bash
curl -sS "$PROXY_API/bot$BOT_TOKEN/getFile?file_id=$FILE_ID"
```

Если local Bot API возвращает absolute path вида `/var/lib/telegram-bot-api/...`, proxy должен переписать его через:

```text
LOCAL_FILE_PATH_REWRITE_FROM=/var/lib/telegram-bot-api
LOCAL_FILE_PATH_REWRITE_TO=./var/telegram-bot-api
```

`/file/...` уходит в cloud только для файлов с известным размером не больше `CLOUD_FILE_FALLBACK_MAX_BYTES`. Большие файлы и неизвестный размер остаются local-only.

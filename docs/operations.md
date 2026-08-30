# Эксплуатация

Команды проверки ниже не перезапускают сервисы и не читают Telegram updates.

## Нормальное состояние

- Local Bot API слушает только `127.0.0.1:8081` и использует persistent volume.
- Proxy слушает только `127.0.0.1:8082`.
- Каждый активный Telegram account OpenClaw использует
  `apiRoot=http://127.0.0.1:8082`.
- `ENABLE_CLOUD_FALLBACK=1`, а
  `ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY=0`.
- `LOCAL_FILE_PATH_REWRITE_TO` указывает на host mount того же volume, который
  контейнер видит как `/var/lib/telegram-bot-api`.
- Принимаемый OpenClaw размер media задан отдельно через
  `channels.telegram.mediaMaxMb`.
- `channels.telegram.timeoutSeconds` больше
  `LOCAL_GETFILE_DOWNLOAD_TIMEOUT_MS / 1000`; для default 7 200 000 мс
  используется не менее 7 500 секунд.

## Read-only проверка

### Process, порты и контейнер

```bash
systemctl --user show openclaw-telegram-api-proxy.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecStart

ss -ltnp '( sport = :8081 or sport = :8082 )'

docker ps --filter publish=8081 \
  --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

Ожидается `active/running`, `NRestarts=0` после последнего планового запуска и
оба loopback listener.

### Безопасный API canary

Token лучше вводить без сохранения в shell history:

```bash
read -rsp 'Bot token: ' BOT_TOKEN
printf '\n'
curl --fail-with-body --silent --show-error \
  "http://127.0.0.1:8082/bot${BOT_TOKEN}/getMe"
unset BOT_TOKEN
```

Ожидается HTTP 200 и `"ok":true`. В proxy log этот запрос должен появиться как
`method=getMe target=local status=200` при здоровом local upstream.

Не вызывайте `getUpdates` вручную, пока OpenClaw polling активен. Второй long
poll может конкурировать с основным consumer и получить Telegram `409`.

### OpenClaw config без вывода token

Путь к config зависит от установки. Для стандартного layout:

```bash
jq '{
  mediaMaxMb: .channels.telegram.mediaMaxMb,
  timeoutSeconds: .channels.telegram.timeoutSeconds,
  accounts: (
    .channels.telegram.accounts
    | to_entries
    | map({
        name: .key,
        enabled: (if (.value | has("enabled")) then .value.enabled else true end),
        apiRoot: .value.apiRoot
      })
  )
}' ~/.openclaw/openclaw.json
```

Каждый enabled account должен смотреть на `:8082`. Эта команда намеренно не
выводит `botToken`.

## Логи

Unit пишет stdout и stderr в один файл. Для стандартного layout:

```bash
tail -n 200 ~/.openclaw/logs/telegram-bot-api-proxy.log
journalctl --user -u openclaw-telegram-api-proxy.service -n 100 --no-pager
```

Основные маркеры:

| Маркер | Значение |
| --- | --- |
| `target=local status=200` | Нормальный local path |
| `local=down` | Health-check увидел network/timeout failure |
| `target=cloud fallbackReason=...` | Сработал разрешённый cloud fallback |
| `action=retry` | Ограниченный local retry `getUpdates` или `getFile` |
| `action=fallback-blocked` | Cloud запрещён policy; причина указана рядом |
| `fallbackReason=cloud-cursor-uninitialized` | `getUpdates` безопасно закрыт без cloud poll |
| `action=poll-queue-rejected status=429` | Заполнена bot-scoped FIFO queue |
| `action=body-read-timeout status=408` | Клиент не закончил body в срок |
| `action=dropped-local-update` | Старый local update удалён из downstream ответа |
| `action=ack-dropped` | Local queue подтверждена до безопасного offset |
| `translatedOffset=yes` | Virtual client offset переведён в native local offset |
| `translatedLocal=yes` | Local native ID переведён в virtual ID |
| `action=virtualized-update-id` | Cloud ID переведён в virtual ID |
| `activeStreaming*=...` | Текущие download/upload/passthrough streams |

Bot token в логах должен иметь вид `<hidden-token>`. Полный token, message text
и media payload в operational log не пишутся.

## Диагностика файлов

### `getFile`

```bash
read -rsp 'Bot token: ' BOT_TOKEN
printf '\n'
read -r -p 'file_id: ' FILE_ID
curl --fail-with-body --silent --show-error \
  --get "http://127.0.0.1:8082/bot${BOT_TOKEN}/getFile" \
  --data-urlencode "file_id=${FILE_ID}"
unset BOT_TOKEN FILE_ID
```

Local response может содержать absolute path. Proxy должен заменить
контейнерный префикс значением `LOCAL_FILE_PATH_REWRITE_TO`. Проверьте, что
получившийся файл реально доступен пользователю OpenClaw Gateway.

### Большой входящий файл

Успешный `getFile` ещё не доказывает, что OpenClaw примет media. Проверяются три
независимых условия:

1. Local Bot API вернул HTTP 200.
2. Переписанный host path доступен Gateway и входит в trusted local roots.
3. `channels.telegram.mediaMaxMb` не ниже фактического размера.
4. `channels.telegram.timeoutSeconds * 1000` больше
   `LOCAL_GETFILE_DOWNLOAD_TIMEOUT_MS`.

Если пункт 1 прошёл, а OpenClaw пишет `MediaFetchError` или общий warning о
скачивании, сравните размер с `mediaMaxMb`. Если `getFile` обрывается до HTTP
200, сравните клиентский `timeoutSeconds` с download window proxy.

### Cloud fallback blocked

HTTP 503 с текстом `cloud fallback blocked` является ожидаемым fail-closed
ответом для тяжёлого, local-sourced или неизвестного файла после local failure.
Это сохраняет корректный source и не отправляет запрос в cloud вслепую.

## Проверка seed

Формат:

```text
LOCAL_UPDATE_STATE_SEED=botId:localFloor:virtualFloor[,botId:localFloor:virtualFloor]
```

Перед созданием или изменением пары:

1. Подтвердите, что `localFloor` — максимальный native local ID, уже пройденный
   этим bridge. Pending update сюда включать нельзя.
2. Найдите максимальный Telegram event ID конкретного bot/account в durable
   ingress OpenClaw.
3. Убедитесь, что `virtualFloor` не ниже этого high-water. Один ACK cursor может
   отставать после handler timeout и для проверки недостаточен.
4. После запуска проверьте startup marker `localUpdateStateSeeds=<count>` и
   первые `translatedOffset`/`translatedLocal` строки.

Ошибочный seed может создать повторный event ID, который durable ingress тихо
дедуплицирует до session routing. Proxy проверяет синтаксис и диапазон чисел,
но не может сам проверить содержимое OpenClaw spool.

## Обновление proxy

1. Зафиксируйте точный commit и сохраните timestamped backup установленного
   каталога и systemd unit.
2. В чистом checkout выполните:

```bash
npm run check
git diff --check
```

3. Устанавливайте весь tracked tree или как минимум весь `src/`; один entrypoint
   без соседних модулей не запустится.
4. Проверьте `systemd-analyze --user verify` для unit.
5. Если `apiRoot` уже указывает на `:8082`, для замены одного proxy bundle
   достаточно `daemon-reload` и restart только proxy service. При первом
   включении длинного `getFile` отдельно задайте OpenClaw
   `channels.telegram.timeoutSeconds`; default hybrid reload перезапустит
   Telegram channel без restart всего Gateway process. Local Bot API restart не
   требуется.
6. После restart проверьте process, listeners, `NRestarts`, `getMe` canary для
   каждого enabled account и error markers в логах.
7. При провале верните целиком предыдущий bundle и unit, затем перезапустите
   только proxy.

Не выполняйте `logOut`, `close`, `setWebhook` или пересоздание persistent Bot
API volume как часть обычного обновления. Эти действия меняют ownership/queue
и относятся к отдельной процедуре переноса Telegram Bot API server:
<https://github.com/tdlib/telegram-bot-api#moving-a-bot-from-one-local-server-to-another>.

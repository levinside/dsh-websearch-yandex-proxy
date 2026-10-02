# dsh-websearch-yandex-proxy

Два способа дать инструменту **`web_search`** из DeepSeek Harness поиск через Yandex.
Клиентская часть (модельный тул `web_search`) не меняется ни в одном из способов:

- **Вариант A — Messages-прокси** (этот сервер, `server.mjs`): подменяется только
  endpoint, на который ходит штатный провайдер `web-search-deepseek`.
- **Вариант B — нативный Cordis-плагин**: корень репозитория — npm-пакет
  `dsh-web-search-yandex` с `dsh.bundle`, провайдер `yandex` живёт в
  процессе харнеса и ходит в Yandex Cloud Search API напрямую, без HTTP-прыжка.
  **Рекомендуется для штатного использования** (так развёрнут текущий профиль).

### Вариант A — диаграмма
```
DeepSeek Harness  ── web_search tool ──►  ctx.web (WebRuntime)
   └─ provider web-search-deepseek ──POST {endpoint}/messages──►
                                             │
                                   ┌─────────▼─────────┐
                                   │  dsh-websearch-   │  Anthropic Messages,
                                   │  yandex-proxy     │  web_search_20250305
                                   │  (этот сервер)    │
                                   └─────────┬─────────┘
                                             │ Yandex Cloud Search API
                                             ▼
                                        Yandex index
```

## Как это устроено

Штатный плагин [web-search-deepseek](https://github.com/deepseek-ai/DeepSeek-Harness)
реализует интерфейс `WebSearchProvider` харнеса и ходит на любой Anthropic-совместимый
`Messages` endpoint. Он шлёт запрос вида:

```json
{
  "model": "deepseek-v4-flash",
  "max_tokens": 4096,
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "Perform a web search for the query: <запрос>" }] }],
  "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }]
}
```

и ждёт ответ с блоками `web_search_tool_result` (url/title/page_age) и `text.citations`
(snippet). Этот сервер реализует ровно этот контракт (без остального Messages API) и
сам выполняет поиск через Yandex. Запросы любых других типов (`file_search`, обычный
чат) сюда не предназначены — это поисковый шлюз.

> **Вариант B этот HTTP-контракт не использует**: плагин регистрирует свой
> `WebSearchProvider` в `ctx.web` и вызывает Yandex Cloud Search API напрямую из
> процесса харнеса (см. раздел ниже).

## Быстрый старт (Вариант A)

Для запуска нужен только Node ≥ 18 (проверено на 24):

```bash
node server.mjs
```

По умолчанию: `http://127.0.0.1:8787`, бэкенд `auto` (если нет ключей — попробует
scrape). Проверка:

```bash
curl -s http://127.0.0.1:8787/healthz
```

## Вариант A — подключение прокси к DeepSeek Harness

> Не путать с Вариантом B: этот раздел настраивает *отдельный процесс* прокси
> (см. ниже «Вариант B — нативный плагин»).

1. Держите сервер запущенным (можно фоном: `nohup node server.mjs &`).
2. В GUI харнеса: **Settings → Plugins → Plugin configuration → Web search** → в поле
   **Endpoint** впишите **`http://127.0.0.1:8787/anthropic/v1`** и сохраните.
   (Либо, если страница настроек недоступна, запустите харнес с переменной
   `DEEPSEEK_SEARCH_BASE_URL=http://127.0.0.1:8787/anthropic/v1`.)
3. Убедитесь, что у провайдера `web-search-deepseek` есть какой-либо API-ключ
   (`DEEPSEEK_API_KEY` или `apiKey` в конфиге плагина) — даже любой строки достаточно:
   прокси его игнорирует, но `available()` провайдера требует наличия ключа.
4. Готово — модель вызывает всё тот же `web_search`, а поиск идёт через Yandex.

### Вариант A через конфиг профиля (если страница настроек недоступна)

Конфиг профиля лежит в `~/.dsh/profiles/<profile>/cordis.patch.yml` (для Web GUI —
профиль `web`). Добавьте туда строку-патч (она заменяет конфиг строки целиком,
поэтому `apiKeyEnv` сохраняем):

```yaml
- id: web-search-deepseek
  name: "@deepseek-ai/dsh-web-search-deepseek"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: http://127.0.0.1:8787/anthropic/v1
```

Правка подхватывается на лету (профиль под watch); перезапуск не нужен — проверено
на живой сессии. Перед правкой сделайте резервную копию файла.

Универсальный curl-тест с тем же телом, что шлёт плагин:

```bash
curl -s -X POST http://127.0.0.1:8787/anthropic/v1/messages \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: deepseek harness"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}'
```

## Вариант B — нативный плагин-провайдер (без локального HTTP-прыжка)

Вместо отдельного процесса прокси можно поставить **Cordis-плагин**: корень
репозитория и есть npm-пакет `dsh-web-search-yandex` с `dsh.bundle`, так что он
ставится **одной командой**. Провайдер регистрируется в шов `ctx.web`, запросы
`web_search` ходят из процесса харнеса напрямую в Yandex Cloud Search API.
Клиентский тул `web_search` не меняется; отдельный сервер и порт 8787 не нужны.

Файлы плагина (корень репозитория):

| Файл | Что делает |
|---|---|
| `package.json` | npm-пакет `dsh-web-search-yandex` (+ `dsh.bundle.patch`, `files`-whitelist) |
| `provider.mjs` | `WebSearchProvider` (id `yandex`): `available()`/`search()` |
| `index.mjs` | Cordis-запись: `name`/`inject`/`apply`, резолв опций из конфига + env |
| `lib/yandex-api.mjs`, `lib/xml.mjs` | Yandex-клиент — **каноничная копия**, общая с Вариантом A (`server.mjs`) |
| `cordis.patch.yml` | bundle-патч, который **вставляет** строку плагина через `- insert:` (новые плагины обязаны вставляться, а не объявляться top-level-строкой — иначе «entry not found») |

> В установленный пакет попадает только `files`-whitelist: `index.mjs`,
> `provider.mjs`, `cordis.patch.yml`, `lib/yandex-api.mjs`, `lib/xml.mjs`.
> Сервер Варианта A, его модули и тесты в инсталляцию не входят.

### Установка в профиль

1. Поставить пакет в профиль (пример для профиля `web`):

   ```bash
   # репозиторий опубликован на GitHub — одна команда:
   dsh plugin --profile web add github:<owner>/<repo>

   # или из локальной копии:
   cd ~/.dsh/profiles/web && pnpm add file:/путь/к/репозиторию
   ```

   > `file:`-установка — это копия по `files`-whitelist, а не симлинк. После
   > изменения кода плагина переустанови: `pnpm remove dsh-web-search-yandex &&
   > pnpm add file:…` (при установке из GitHub — заново `dsh plugin add …`).

2. Добавить пакет в список бандлов профиля (`package.json` → `dsh.profile.bundles`),
   иначе загрузчик не узнает модуль как entry (ровно так устроены `dshmarket`
   и `dsh-sound-cue`):

   ```json
   "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "…", "dsh-web-search-yandex" ] } }
   ```

3. В `cordis.patch.yml` профиля выбрать его как поисковый провайдер и отключить
   DeepSeek. Строка `web-search-yandex` здесь — **переопределение конфига** строки,
   которую вставил bundle-патч плагина (патч заменяет конфиг целиком, поэтому
   `fetchProvider` и имя строки сохраняем):

   ```yaml
   - id: web
     name: "@deepseek-ai/dsh-web"
     config:
       searchProvider: yandex
       fetchProvider: http
   - id: web-search-deepseek
     disabled: true
   - id: web-search-yandex
     name: dsh-web-search-yandex
     config:
       apiKey: AQVN...
       folderId: b1g...
   ```

   Ключи берутся из конфига строки (`apiKey`/`folderId`/`baseURL`/`searchType`/`l10n`/`maxResults`),
   при отсутствии — из env (`YANDEX_API_KEY`, `YANDEX_FOLDER_ID`; имена env настраиваются
   через `apiKeyEnv`/`folderIdEnv`).

4. Перезапустить харнес и проверить, что поиск идёт напрямую в Яндекс (например,
   дёрнуть `web_search` в чате или `dsh --profile web --dump-config | grep -i yandex`
   для проверки собранного дерева). Процесс прокси (Вариант A) можно остановить.

Проверка собранного дерева без запуска приложения:

```bash
dsh --profile web --dump-config   # в дереве должны быть id: web-search-yandex и disabled: true у deepseek
```

Плагин самодостаточен: у него нет зависимостей от `@deepseek-ai/*`, поэтому он
резолвится из своего собственного дерева модулей в профиле (как уже установленные
там `dshmarket`/`dsh-sound-cue`). По той же причине он не зависит от Cordis-типов
и Schemastery — конфиг читается как обычный объект строки патча. Yandex-клиент
лежит в `lib/` и является **единственной** копией, общей с Вариантом A — никакого
дублирования и стражника синхронизации больше не нужно.

> **Важно про перезапуск.** Правки значений существующих строк применяются на лету
> (`patchReload: "live"`), но **новая строка-плагин, изменение списка `bundles` и
> переустановка пакета подхватываются только при перезапуске харнеса** (новый
> модуль — `restart-required` по коду HMR). На время между сохранением патча и
> рестартом `web_search` в запущенной сессии будет недоступен (конфиг уже указывает
> на `yandex`, а провайдер ещё не зарегистрирован).

## Бэкенды

| `YANDEX_BACKEND` | Что делает | Когда использовать |
|---|---|---|
| `api` | Официальный **Yandex Cloud Search API** (REST, `searchapi.api.cloud.yandex.net/v2/web/search`, результат — base64-XML). Надёжно, без капчи, платно по тарифу (бесплатная квота ~250 000 синхронных запросов/мес). | **Рекомендуется**; нужны `YANDEX_API_KEY` + `YANDEX_FOLDER_ID`. |
| `scrape` | Best-effort парсинг публичной выдачи `yandex.com`/`yandex.ru` без ключа. `url=`-обёртки разворачиваются только в публичные `http(s)`-адреса: приватные/loopback/link-local отбрасываются (SSRF-гард). | Только как резерв; **капча почти всегда** (проверено: и `.com`, и `.ru` отдают SmartCaptcha даже с этой машины). |
| `mock` | Детерминированные фейковые результаты (для тестов). | Локальная отладка протокола. |
| `auto` (по умолчанию) | Есть ключи → `api`, нет → `scrape`. | Рядовой запуск. |

## Переменные окружения

Все в `[.env.example](.env.example)`; конфиг-файлов нет.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `YANDEX_PROXY_HOST` | `127.0.0.1` | Адрес прослушивания. |
| `YANDEX_PROXY_PORT` | `8787` | Порт. |
| `YANDEX_BACKEND` | `auto` | `auto` / `api` / `scrape` / `mock`. |
| `YANDEX_API_KEY` | — | Ключ поиска Yandex Cloud (вида `AQVN...`). |
| `YANDEX_FOLDER_ID` | — | ID каталога Yandex Cloud, которому принадлежит ключ. |
| `YANDEX_SEARCH_API_URL` | `https://searchapi.api.cloud.yandex.net/v2/web/search` | Endpoint официального API. |
| `YANDEX_SEARCH_TYPE` | `SEARCH_TYPE_RU` | Сегмент выдачи (RU / EN / …). |
| `YANDEX_L10N` | `LOCALIZATION_RU` | Локализация. |
| `YANDEX_SCRAPE_HOST` | `yandex.com` | Хост для scrape-бэкенда. |
| `YANDEX_REQUEST_TIMEOUT_MS` | `15000` | Таймаут бэкенда. |
| `YANDEX_MAX_RESULTS` | `10` | Верхняя граница источников (тул-слой харнеса всё равно режет до 8). |
| `YANDEX_MAX_REQUEST_BYTES` | `1000000` | Лимит тела POST. |

## Настройка Yandex Cloud Search API (один раз)

1. В [Yandex Cloud](https://console.cloud.yandex.ru) создайте каталог (или возьмите
   существующий) и запомните его **folder id**.
2. Включите сервис **Yandex Search API** в этом каталоге.
3. Создайте **сервисный аккаунт** и выдайте ему роль **`search-api.webSearch.user`**
   на каталог.
4. Создайте ключ **в карточке сервиса Yandex Search API**: он выдаёт специальный
   ключ с областью `yc.search-api.execute` (строка `AQVN...`), привязанный к
   сервисному аккаунту. Обычный «API-ключ» сервисного аккаунта из раздела
   «Сервисные аккаунты» работать может не начать: без области/роли сервис вернёт
   `403 PermissionDenied` с перечислением каталога/облака/организации — проверьте,
   что ключ создан в том каталоге, на который выдана роль.
5. Запустите:

```bash
YANDEX_API_KEY=AQVN... YANDEX_FOLDER_ID=b1g... node server.mjs
```

Описания полей API взяты из [официальной документации](https://aistudio.yandex.ru/ru/docs/search-api/)
и сверены с рабочей реализацией SearXNG-движка для Yandex Cloud Search.

## Тесты

```bash
npm test                     # то же: node --test test.mjs provider.test.mjs
```

Два файла:
- `test.mjs` — Вариант A: извлечение запроса (в т.ч. префикс
  `Perform a web search for the query:`), сборка ответа (блоки
  `web_search_tool_result` + `text.citations`), парсинг base64-XML официального API,
  парсинг HTML-выдачи для scrape, детект капчи, E2E по HTTP (все три пути Messages,
  healthz, ошибки, таймаут→504, переполнение тела→400).
- `provider.test.mjs` — Вариант B: резолв опций, `available()`, нормализация
  результатов, применение `maxResults`, маппинг ошибок (`WEB_PROVIDER_ERROR`/`WEB_ABORTED`),
  регистрация через `apply()`.

## Ограничения и честные оговорки

- **Капча**: публичный поиск Яндекса со сканера почти всегда отдаёт SmartCaptcha
  (проверено с `.com` и `.ru`). Scrape — резерв, а не решение. Надёжный путь — только
  официальный API с ключом.
- **Метаданные**: `publishedAt` не заполняются (ни API, ни скрейпер не отдают надёжную
  дату публикации); строка `(дата)` в сниппетах просто отсутствует.
- **Один запрос — один поиск**: `max_uses > 1` плагина не превращается в несколько
  поисков; контракт тула от этого не страдает.
- **Отмена запроса (Вариант A)**: при обрыве соединения от клиента апстрим-поиск
  отменяется и обрабатывается той же веткой 504, что и таймаут (сервер продолжает
  работать).
- **Область**: сервер реализует только контракт `web_search_20250305`; это не полный
  Anthropic Messages gateway.

## Лицензия

MIT.

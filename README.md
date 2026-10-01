# dsh-websearch-yandex-proxy

Локальный прокси для инструмента **`web_search`** из DeepSeek Harness, который ищет
через **Yandex** под капотом. Клиентская часть (модельный тул `web_search`) не меняется
ни строчкой — подменяется только endpoint, на который ходит штатный провайдер
`web-search-deepseek`.

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

## Быстрый старт

Для запуска нужен только Node ≥ 18 (проверено на 24):

```bash
node server.mjs
```

По умолчанию: `http://127.0.0.1:8787`, бэкенд `auto` (если нет ключей — попробует
scrape). Проверка:

```bash
curl -s http://127.0.0.1:8787/healthz
```

## Подключение к DeepSeek Harness

1. Держите сервер запущенным (можно фоном: `nohup node server.mjs &`).
2. В GUI харнеса: **Settings → Plugins → Plugin configuration → Web search** → в поле
   **Endpoint** впишите **`http://127.0.0.1:8787/anthropic/v1`** и сохраните.
   (Либо, если страница настроек недоступна, запустите харнес с переменной
   `DEEPSEEK_SEARCH_BASE_URL=http://127.0.0.1:8787/anthropic/v1`.)
3. Убедитесь, что у провайдера `web-search-deepseek` есть какой-либо API-ключ
   (`DEEPSEEK_API_KEY` или `apiKey` в конфиге плагина) — даже любой строки достаточно:
   прокси его игнорирует, но `available()` провайдера требует наличия ключа.
4. Готово — модель вызывает всё тот же `web_search`, а поиск идёт через Yandex.

### Вариант через конфиг профиля (если страница настроек недоступна)

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

Вместо отдельного процесса прокси можно поставить **Cordis-плагин** (`plugin/`),
который регистрирует свой `WebSearchProvider` в шов `ctx.web`: запросы `web_search`
ходят из процесса харнеса напрямую в Yandex Cloud Search API. Клиентский тул
`web_search` не меняется; отдельный сервер и порт 8787 больше не нужны.

Файлы плагина:

| Файл | Что делает |
|---|---|
| `plugin/package.json` | npm-пакет `dsh-web-search-yandex` (+ `dsh.bundle.patch`) |
| `plugin/provider.mjs` | `WebSearchProvider` (id `yandex`): `available()`/`search()` via вендоренного клиента |
| `plugin/index.mjs` | Cordis-запись: `name`/`inject`/`apply`, резолв опций из конфига + env |
| `plugin/lib/` | Вендоренная копия клиента Yandex (`yandex-api.mjs` + `xml.mjs`) — пакет самодостаточен при установке |
| `plugin/cordis.patch.yml` | bundle-патч, который **вставляет** строку плагина через `- insert:` (новые плагины обязаны вставляться, а не объявляться top-level-строкой — иначе «entry not found») |

### Установка в профиль

1. Поставить пакет в профиль (пример для профиля `web`):

   ```bash
   cd ~/.dsh/profiles/web && pnpm add file:/путь/к/yandex-search-proxy/plugin
   ```

1b. Добавить пакет в список бандлов профиля (`package.json` → `dsh.profile.bundles`),
   иначе загрузчик не узнает модуль как entry (ровно так устроены `dshmarket`
   и `dsh-sound-cue`):

   ```json
   "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "…", "dsh-web-search-yandex" ] } }
   ```

2. В `cordis.patch.yml` профиля выбрать его как поисковый провайдер и отключить
   DeepSeek (патч заменяет конфиг строки целиком, поэтому `fetchProvider` сохраняем):

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
   при отсутствии — из env (`YANDEX_API_KEY`, `YANDEX_FOLDER_ID` и т.д.).

3. Перезапустить харнес (появление нового модуля в `node_modules` профиля требует
   перезагрузки, в отличие от правок значений). После этого `web_search` идёт
   напрямую в Яндекс; процесс прокси можно остановить.

Плагин самодостаточен: у него нет зависимостей от `@deepseek-ai/*`, поэтому он
резолвится из своего собственного дерева модулей в профиле (как уже установленные
там `dshmarket`/`dsh-sound-cue`). По той же причине он не зависит от Cordis-типов
и Schemastery — конфиг читается как обычный объект строки патча. Yandex-клиент
вендорится в `plugin/lib/` (pnpm ставит `file:`-пакет копией, а не симлинком);
тест-стражник следит, чтобы `plugin/lib/*` не расходились с `lib/*`.

> **Важно про перезапуск.** Правки значений существующих строк применяются на лету
> (`patchReload: "live"`), но **новая строка-плагин подхватывается только при
> перезапуске харнеса** (новый модуль — `restart-required` по коду HMR). На время
> между сохранением патча и рестартом `web_search` в запущенной сессии будет
> недоступен (конфиг уже указывает на `yandex`, а провайдер ещё не зарегистрирован).

## Бэкенды

| `YANDEX_BACKEND` | Что делает | Когда использовать |
|---|---|---|
| `api` | Официальный **Yandex Cloud Search API** (REST, `searchapi.api.cloud.yandex.net/v2/web/search`, результат — base64-XML). Надёжно, без капчи, платно по тарифу (бесплатная квота ~250 000 синхронных запросов/мес). | **Рекомендуется**; нужны `YANDEX_API_KEY` + `YANDEX_FOLDER_ID`. |
| `scrape` | Best-effort парсинг публичной выдачи `yandex.com`/`yandex.ru` без ключа. | Только как резерв; **Russian «капча почти всегда»** (проверено: и `.com`, и `.ru` отдают SmartCaptcha даже с этой машины). |
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
4. Для сервисного аккаунта создайте **API-ключ** (выдаётся строка вида `AQVN...`).
5. Запустите:

```bash
YANDEX_API_KEY=AQVN... YANDEX_FOLDER_ID=b1g... node server.mjs
```

Описания полей API взяты из [официальной документации](https://aistudio.yandex.ru/ru/docs/search-api/)
и сверены с рабочей реализацией SearXNG-движка для Yandex Cloud Search.

## Тесты

```bash
node --test test.mjs
```

Покрыто: извлечение запроса (в т.ч. префикс `Perform a web search for the query:`),
сборка ответа (блоки `web_search_tool_result` + `text.citations`), парсинг base64-XML
официального API, парсинг HTML-выдачи для scrape, E2E по HTTP (все три пути
Messages, healthz, ошибки).

## Ограничения и честные оговорки

- **Капча**: публичный поиск Яндекса со сканера почти всегда отдаёт SmartCaptcha
  (проверено с `.com` и `.ru`). Scrape — резерв, а не решение. Надёжный путь — только
  официальный API с ключом.
- **Метаданные**: `publishedAt` не заполняются (ни API, ни скрейпер не отдают надёжную
  дату публикации); строка `(дата)` в сниппетах просто отсутствует.
- **Один запрос — один поиск**: `max_uses > 1` плагина не превращается в несколько
  поисков; контракт тула от этого не страдает.
- **Область**: сервер реализует только контракт `web_search_20250305`; это не полный
  Anthropic Messages gateway.

## Лицензия

MIT.

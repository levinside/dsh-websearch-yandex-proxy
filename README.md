# dsh-web-search-yandex

Плагин **`dsh-web-search-yandex`** даёт инструменту **`web_search`** в DeepSeek Harness поиск через **Yandex** (официальный Yandex Cloud Search API). Модельный тул `web_search` не меняется — под капотом подключается нативный провайдер, живущий в процессе харнеса.

> Альтернативный вариант (standalone HTTP-прокси) убран из основной ветки; его рабочая версия сохранена в теге `v-standalone-proxy` (появление плагина — `v-plugin-provider`, переход к текущей структуре пакета — `v-plugin-only`).

## Как это устроено

```
web_search (модельный тул)
   └─ ctx.web → WebSearchProvider id "yandex" (плагин, в процессе харнеса)
        └─ Yandex Cloud Search API (REST v2, Api-Key) — отложенный режим:
             1. POST searchAsync                     → { id: "<operation-id>", done: false }
             2. GET operation.api.cloud.yandex.net/… → поллинг до { done: true }
             3. response.rawData (base64-XML)        → источники
             └─ результаты → web_search_tool_result + text.citations → модель
```

Плагин реализует интерфейс `WebSearchProvider` шва `ctx.web`, вызывает `lib/yandex-api.mjs` (submit `searchAsync`, опрос операции, парсинг base64-XML, вырезка `<hlword>`) и возвращает источники в формате, который тул уже умеет рендерить. Поиск идёт в **отложенном (deferred) режиме** — он в ~16 раз дешевле синхронного (см. [Синхронный vs отложенный режим](#синхронный-vs-отложенный-режим)). Запрос к харнесу — один на «одну выдачу» (см. [Ограничения](#ограничения-и-честные-оговорки)).

### Файлы

| Файл | Что делает |
|---|---|
| `index.mjs` | Cordis-запись: `name`/`inject`/`apply`, резолв опций из конфига + env |
| `provider.mjs` | `WebSearchProvider` (id `yandex`): `available()`/`search()` |
| `lib/yandex-api.mjs`, `lib/xml.mjs` | Yandex-клиент и XML-декодер |
| `cordis.patch.yml` | bundle-патч: вставляет строку плагина через `- insert:` |
| `package.json` | манифест: `dsh.bundle.patch`, `files`-whitelist |

## Установка

0. **Креды Yandex Search API** — каталог + роль + ключ (см. [Настройка](#настройка-yandex-cloud-search-api-один-раз)). Секретов в репозитории нет.

1. Поставить пакет в профиль (пример для профиля `web`):

   ```bash
   # репозиторий опубликован — одна команда:
   dsh plugin --profile web add github:<owner>/<repo>

   # или из локальной копии:
   cd ~/.dsh/profiles/web && pnpm add file:/путь/к/репозиторию
   ```

   > `file:`-установка — это копия по `files`-whitelist, а не симлинк. После изменения кода плагина переустанови: `pnpm remove dsh-web-search-yandex && pnpm add file:…` (при установке из GitHub — заново `dsh plugin add …`).

2. Добавить пакет в `dsh.profile.bundles` профиля (`package.json`), иначе загрузчик не узнает модуль как entry (`entry "web-search-yandex" not found`):

   ```json
   "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "…", "dsh-web-search-yandex" ] } }
   ```

3. В `cordis.patch.yml` профиля выбрать провайдер и отключить DeepSeek. Строка `web-search-yandex` здесь — **переопределение конфига** строки, которую вставил bundle-патч плагина (патч заменяет конфиг целиком, поэтому `fetchProvider` и имя строки сохраняем):

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
       pollTimeoutMs: 120000    # ≥ бюджета web_search, см. ниже
   ```

   > **Про бюджет `web_search` (важно).** Отложенная очередь Яндекса в часы нагрузки растягивает операцию до 24–124 с, а иногда и больше. Штатный бюджет тула — 60 с (`tool-web.config.searchTimeoutMs` в base bundle), поэтому его стоит поднять: иначе поиск обрывается ровно тогда, когда Yandex вот-вот отдаст результат (и уже списал его). `pollTimeoutMs` плагина должен быть **не меньше** этого бюджета — тогда интерактивный вызов ограничивает `AbortSignal` тула, а не таймер провайдера.
   >
   > Где именно живёт бюджет, зависит от профиля. В **web-профиле** host-строка `tool-web` отключена (`disabled: true`), а `web_search` монтируется внутри каждого agent-preset (`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`), и вложенные строки патчем по id не адресуются. Поэтому бюджет меняют **переопределением строки пресета целиком** — patch заменяет `config`, так что в профиль кладут его `plugins` со всеми плагинами пресета и правят один `searchTimeoutMs`:
   >
   > ```yaml
   > # один раз: config.plugins скопирован из dsh-web-app/presets/standard.patch.yml,
   > # изменено только searchTimeoutMs у tool-web (60000 → 90000)
   > - id: preset-standard
   >   name: '@deepseek-ai/dsh-agent-preset'
   >   config:
   >     id: standard
   >     order: 1
   >     plugins:
   >       - id: persona
   >         name: '@deepseek-ai/dsh-persona'
   >         # ... остальные 21 плагин пресета без изменений ...
   >       - id: tool-web
   >         name: '@deepseek-ai/dsh-tool-web'
   >         config:
   >           fetch: true
   >           searchTimeoutMs: 90000
   > ```
   >
   > Это единственный способ дотянуться до бюджета в web-профиле; цена — закреплённая копия списка плагинов пресета, которую надо пере-синхронизировать при обновлении DSH. Если пресет не переопределяют, действует штатные 60 с: плагин всё равно переживёт 20-секундные обрывы, но операции длиннее 60 с будут заканчиваться таймаутом тула. Хотите ждать дольше — поднимайте оба значения вместе (`searchTimeoutMs: 150000`, `pollTimeoutMs: 160000`).

4. Перезапустить харнес и проверить (см. ниже).

> **Про перезапуск.** Правки значений существующих строк применяются на лету (`patchReload: "live"`), но **новая строка-плагин, изменение `bundles` и переустановка пакета подхватываются только при перезапуске**. На время между сохранением патча и рестартом `web_search` в запущенной сессии недоступен (конфиг уже указывает на `yandex`, а провайдер ещё не зарегистрирован).

## Конфигурация

Все опции берутся из конфига строки плагина. Переменные окружения (`.env`) не используются — секреты живут в реестре креденшелов харнеса (см. ниже).

| Конфиг строки | Назначение | По умолчанию |
|---|---|---|
| `apiKey` / `apiKeyRef` | Литеральный ключ / имя credential-ref’а в реестре (нежирный: литерал кладёт секрет в конфиг) | `YANDEX_API_KEY` |
| `folderId` / `folderIdRef` | Литеральный folder id / имя credential-ref’а | `YANDEX_FOLDER_ID` |
| `baseURL` | Endpoint API (deferred `searchAsync`) | `https://searchapi.api.cloud.yandex.net/v2/web/searchAsync` |
| `searchType` | Сегмент выдачи | `SEARCH_TYPE_COM` |
| `l10n` | Локализация | `LOCALIZATION_EN` |
| `maxResults` | Верхняя граница источников | `10` |
| `pollTimeoutMs` | Бюджет ожидания отложенной операции, мс; держать **≥ `searchTimeoutMs`** тула | `120000` |
| `pollIntervalMs` | Пауза между опросами операции, мс | `500` |
| `pollFirstDelayMs` | Пауза перед первым опросом операции, мс | `300` |
| `maxConcurrentSearches` | Сколько поисков выполняются одновременно: тул шлёт до 4 запросов на вызов, но провайдер ставит их в очередь (Yandex отвечает 429 при нескольких pending-операциях) | `2` |

### Где хранятся секреты

Ключ и folder id резолвятся так (без любого участия env):

1. **Литерал в конфиге** — `apiKey` / `folderId` (не рекомендуется: секрет попадает в конфиг строки плагина).
2. **Credential-seam харнеса** — `ctx.credentials.resolve(имя_ref)`: страница **Models** в вебе харнеса хранит значения в `~/.dsh/.credentials.yaml` (секция `refs:`). Имя ref’а берётся из `apiKeyRef` / `folderIdRef`. Это основной путь.

Секретов в конфиге нет, `.env` не нужен и не читается. Если значение уже лежит в `.credentials.yaml` под именем `YANDEX_API_KEY` / `YANDEX_FOLDER_ID`, плагин найдёт его через seam при каждом поиске (асинхронно, с учётом `AbortSignal`, без кэширования в провайдере).

Сегмент по умолчанию — международный (`SEARCH_TYPE_COM`) с английской локализацией уведомлений (`LOCALIZATION_EN`) — он лучше подходит для свежего глобального контента (в т.ч. AI-новостей). Для выдачи по Рунету/русскоязычной повестке задай `SEARCH_TYPE_RU` + `LOCALIZATION_RU`. Другие допустимые значения `l10n`: `LOCALIZATION_UK`, `LOCALIZATION_BE`, `LOCALIZATION_KK`, `LOCALIZATION_TR`. Значения вида `LOCALIZATION_COM` в enum API не существует (это значение `searchType`, а не `l10n`) — API отвечает HTTP 400.

**Сколько приходит ответов (каскад «10 → 8»).** `maxResults` (по умолчанию `10`) — верхняя граница, которую плагин просит у API (`groupsOnPage`) и которой обрезает парсинг. Сверху тул-слой харнеса дополнительно режет выдачу до 8, поэтому модель видит не больше 8 результатов. Дефолт держим на `10` как запас: если кап тул-слоя поднимут, модель сразу получит больше без правки конфига.

Если ref’ы не находятся — поиск падает с читаемой ошибкой `WEB_PROVIDER_CREDENTIAL_MISSING` (перечисляет недостающие ref’ы и способы их задать).

## Синхронный vs отложенный режим

Плагин работает в **отложенном (deferred/async)** режиме: синхронный эндпоинт `POST /v2/web/search` (ответ содержит результаты сразу) заменён на `searchAsync` + опрос операции. Причина — тариф: отложенный режим **в ~16 раз дешевле** синхронного.

| Режим | Тариф, ₽ за 1000 запросов |
|---|---|
| Синхронный, дневной | 488 |
| Синхронный, ночной | 366 |
| **Отложенный** | **30,5** |

Актуальные цены и условия: [Правила тарификации Yandex Search API](https://aistudio.yandex.ru/ru/docs/search-api/pricing).

Как устроен флоу (тело запроса — то же, что у синхронного режима):

1. `POST https://searchapi.api.cloud.yandex.net/v2/web/searchAsync` с `Authorization: Api-Key …` — ответ `{"id": "<operation-id>", "done": false}`: это **не результаты**, а идентификатор операции.
2. `GET https://operation.api.cloud.yandex.net/operations/<operation-id>` (тот же `Api-Key`) — опрос до `{"done": true, "response": {"rawData": "<base64 XML>"}}`. Операция обычно готова за доли секунды, но в часы нагрузки отложенная очередь Яндекса растягивает её до десятков секунд и **до ~2 минут** (наблюдалось 24–124 с и 2 м 03 с – 2 м 24 с). Плагин опрашивает с первым интервалом ~300 мс и шагом ~500 мс; бюджет ожидания — `pollTimeoutMs`, по умолчанию **120 с**; при HTTP 429/5xx опрос повторяется с паузой, при `AbortSignal` ожидание прерывается сразу. Интерактивный вызов ограничивает не этот таймер, а бюджет тула `web_search` (`tool-web.config.searchTimeoutMs`), поэтому `pollTimeoutMs` держим **не меньше** него.
3. Из `response.rawData` (base64-декодированный XML) парсятся `<doc>`-элементы. Пустая выдача приходит как `<error code="15">` («комбинация слов нигде не встречается») — это не ошибка, а пустой список результатов.

Тарифицируется запуск поиска (`searchAsync`), а не опрос статуса операции. Учтите: **повторная отправка тоже платная** — ретрай submit при 429/5xx создаёт новую операцию, поэтому попыток немного (3) и они разнесены экспоненциально с джиттером. HTTP 429 `Too many pending requests, retry later` возникает в первую очередь от параллельности: харнес выполняет до четырёх запросов одного `web_search` одновременно, и каждый — отдельный `searchAsync`. Поэтому провайдер сам ограничивает число одновременных поисков (`maxConcurrentSearches`, по умолчанию `2`): лишние встают в очередь и не создают операцию, пока не освободится слот. Это не даёт ни 429, ни углубления отложенной очереди Яндекса.

## Проверка и диагностика

Собранное дерево профиля без запуска приложения:

```bash
dsh --profile web --dump-config   # в дереве: id: web-search-yandex; deepseek disabled: true
```

Типовые ошибки:

| Ошибка | Что делать |
|---|---|
| `configured web provider "yandex" is not registered` | харнес не перезапущен — перезапусти |
| `entry "web-search-yandex" not found` | пакет не в `bundles` или не переустановлен |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | ref’ы (`YANDEX_API_KEY` / `YANDEX_FOLDER_ID`) не найдены при поиске — сохрани их на странице Models (секция `refs:`) или пропиши литерал `apiKey`/`folderId` в конфиг |
| `403 PermissionDenied` | роль/ключ не на том каталоге; создай ключ в карточке Search API |
| `Yandex Search API operation … did not finish within …ms` | отложенная операция не успела за бюджет: подними `pollTimeoutMs` плагина **и** `searchTimeoutMs` тула в `config.plugins` своего agent-preset (см. «Про бюджет `web_search`»; `pollTimeoutMs` ≥ `searchTimeoutMs`), либо повтори поиск — операция на стороне Yandex всё равно завершится |
| `HTTP 429 … Too many pending requests, retry later` | многовато одновременных отложенных операций: плагин ретраит сам (3 попытки), при устойчивом 429 — не запускай несколько `web_search` параллельно |

## Настройка Yandex Cloud Search API (один раз)

1. В [Yandex Cloud](https://console.cloud.yandex.ru) создайте каталог (или возьмите существующий) и запомните его **folder id**.
2. Включите сервис **Yandex Search API** в этом каталоге.
3. Создайте **сервисный аккаунт** и выдайте ему роль **`search-api.webSearch.user`** на каталог.
4. Создайте ключ **в карточке сервиса Yandex Search API**: он выдаёт специальный ключ с областью `yc.search-api.execute` (строка `AQVN...`), привязанный к сервисному аккаунту. Обычный «API-ключ» из раздела «Сервисные аккаунты» может не заработать: без области/роли сервис вернёт `403 PermissionDenied`.

5. Положите ключ и folder id в харнес: страница **Models** (пишет значения в `~/.dsh/.credentials.yaml`, раздел `refs:` под именами `YANDEX_API_KEY` / `YANDEX_FOLDER_ID`). Тогда в конфиге строки плагина достаточно `apiKeyRef: YANDEX_API_KEY` / `folderIdRef: YANDEX_FOLDER_ID` — секретов в конфиге нет (см. «Где хранятся секреты»).

Тарификация сервиса (цены за запросы, квоты и как их увеличить): [Правила тарификации Yandex Search API](https://aistudio.yandex.ru/ru/docs/search-api/pricing). Списание — за запрос; квота на число запросов в сутки задаётся в консоли сервиса («Увеличить квоту»).

Описания полей API взяты из [официальной документации](https://aistudio.yandex.ru/ru/docs/search-api/) и сверены с рабочей реализацией SearXNG-движка для Yandex Cloud Search.

## Тесты

```bash
npm test   # node --test provider.test.mjs lib/yandex-api.test.mjs — плагин: резолв опций и
           # креденшелов (литерал > credential-seam; env не используется), available(),
           # нормализация, maxResults, проброс pollTimeoutMs/pollIntervalMs/pollFirstDelayMs,
           # лимит одновременных поисков (maxConcurrentSearches: кап по умолчанию,
           # настраиваемый кап, abort ожидающего без утечки слота),
           # отложенный флоу searchAsync → опрос операции
           # (повтор поллинга при 429/5xx, таймаут с op id и подсказкой, abort,
           # operation.error, пустая выдача через <error code="15">),
           # ретрай submit при 429/5xx (успех, исчерпание попыток, отсутствие ретрая
           # для прочих 4xx, abort во время backoff), обрезка queryText до 400 символов
           # (+ лог при обрезке), маппинг ошибок
           # (WEB_PROVIDER_ERROR/WEB_ABORTED/WEB_PROVIDER_CREDENTIAL_MISSING),
           # регистрация через apply()
```

Тесты не ходят в сеть: `lib/yandex-api.test.mjs` стабит `globalThis.fetch` (submit + серии poll-ответов), `provider.test.mjs` инжектит фейковый бэкенд.

## Ограничения и честные оговорки

- **Метаданные**: `publishedAt` не заполняются (API не отдаёт надёжную дату публикации).
- **Длина запроса**: `queryText` ограничен Yandex до 400 символов; плагин обрезает запрос до этой длины по Unicode code points, не разбивая суррогатные пары (эмодзи).
- **Отложенный режим**: на одну выдачу уходит больше одного HTTP-вызова (submit `searchAsync` + опросы операции), тарифицируется только запуск поиска — но каждая принятая отправка, включая ретрай при 429/5xx, это отдельная платная операция. Для тула и модели поведение не отличается от синхронного.
- **Латентность отложенного режима — переменная**: обычно 1–3 с, в часы нагрузки — 20–124 с и до ~2 м 24 с (очередь на стороне Яндекса, конфигом не управляется). Поэтому `pollTimeoutMs`/`searchTimeoutMs` подняты. Запросы одного `web_search` провайдер выполняет не больше двух одновременно (`maxConcurrentSearches`), поэтому при 4 запросах ожидание идёт двумя волнами; одна застрявшая операция всё равно валит весь вызов тула — шов харнеса не отдаёт частичный результат.
- **Один запрос — один поиск**: `max_uses > 1` не превращается в несколько поисков; контракт тула от этого не страдает.

## Лицензия

MIT.

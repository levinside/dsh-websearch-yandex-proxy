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
   ```

4. Перезапустить харнес и проверить (см. ниже).

> **Про перезапуск.** Правки значений существующих строк применяются на лету (`patchReload: "live"`), но **новая строка-плагин, изменение `bundles` и переустановка пакета подхватываются только при перезапуске**. На время между сохранением патча и рестартом `web_search` в запущенной сессии недоступен (конфиг уже указывает на `yandex`, а провайдер ещё не зарегистрирован).

## Конфигурация

Ключи и опции берутся из конфига строки плагина, при отсутствии — из переменных окружения харнеса:

| Конфиг строки | Env | Назначение | По умолчанию |
|---|---|---|---|
| `apiKey` / `apiKeyEnv` | `YANDEX_API_KEY` | Ключ поиска (`AQVN...`) | — |
| `folderId` / `folderIdEnv` | `YANDEX_FOLDER_ID` | Каталог Yandex Cloud | — |
| `baseURL` | `YANDEX_SEARCH_API_URL` | Endpoint API (deferred `searchAsync`) | `https://searchapi.api.cloud.yandex.net/v2/web/searchAsync` |
| `searchType` | `YANDEX_SEARCH_TYPE` | Сегмент выдачи | `SEARCH_TYPE_COM` |
| `l10n` | `YANDEX_L10N` | Локализация | `LOCALIZATION_COM` |
| `maxResults` | `YANDEX_MAX_RESULTS` | Верхняя граница источников | `10` |

Сегмент по умолчанию — международный (`SEARCH_TYPE_COM`), он лучше подходит для свежего глобального контента (в т.ч. AI-новостей). Для выдачи по Рунету/русскоязычной повестке задай `SEARCH_TYPE_RU` + `LOCALIZATION_RU`.

**Сколько приходит ответов (каскад «10 → 8»).** `maxResults` (по умолчанию `10`) — верхняя граница, которую плагин просит у API (`groupsOnPage`) и которой обрезает парсинг. Сверху тул-слой харнеса дополнительно режет выдачу до 8, поэтому модель видит не больше 8 результатов. Дефолт держим на `10` как запас: если кап тул-слоя поднимут, модель сразу получит больше без правки конфига.

При неработающих кредах плагин пишет в лог понятное предупреждение (`set config apiKey/folderId or export YANDEX_API_KEY / YANDEX_FOLDER_ID`).

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
2. `GET https://operation.api.cloud.yandex.net/operations/<operation-id>` (тот же `Api-Key`) — опрос до `{"done": true, "response": {"rawData": "<base64 XML>"}}`. Операция обычно готова за доли секунды; плагин опрашивает с первым интервалом ~300 мс и шагом ~500 мс, с общим бюджетом времени ~20 с. При HTTP 429/5xx опрос повторяется с паузой, при `AbortSignal` ожидание прерывается сразу.
3. Из `response.rawData` (base64-декодированный XML) парсятся `<doc>`-элементы. Пустая выдача приходит как `<error code="15">` («комбинация слов нигде не встречается») — это не ошибка, а пустой список результатов.

Тарифицируется запуск поиска (`searchAsync`), а не опрос статуса операции.

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
| `403 PermissionDenied` | роль/ключ не на том каталоге; создай ключ в карточке Search API |

## Настройка Yandex Cloud Search API (один раз)

1. В [Yandex Cloud](https://console.cloud.yandex.ru) создайте каталог (или возьмите существующий) и запомните его **folder id**.
2. Включите сервис **Yandex Search API** в этом каталоге.
3. Создайте **сервисный аккаунт** и выдайте ему роль **`search-api.webSearch.user`** на каталог.
4. Создайте ключ **в карточке сервиса Yandex Search API**: он выдаёт специальный ключ с областью `yc.search-api.execute` (строка `AQVN...`), привязанный к сервисному аккаунту. Обычный «API-ключ» из раздела «Сервисные аккаунты» может не заработать: без области/роли сервис вернёт `403 PermissionDenied`.

Тарификация сервиса (цены за запросы, квоты и как их увеличить): [Правила тарификации Yandex Search API](https://aistudio.yandex.ru/ru/docs/search-api/pricing). Списание — за запрос; квота на число запросов в сутки задаётся в консоли сервиса («Увеличить квоту»).

Описания полей API взяты из [официальной документации](https://aistudio.yandex.ru/ru/docs/search-api/) и сверены с рабочей реализацией SearXNG-движка для Yandex Cloud Search.

## Тесты

```bash
npm test   # node --test provider.test.mjs lib/yandex-api.test.mjs — плагин: резолв опций,
           # available(), нормализация, maxResults, отложенный флоу searchAsync → опрос операции
           # (повтор поллинга при 429/5xx, таймаут поллинга, abort, operation.error,
           # пустая выдача через <error code="15">), обрезка queryText до 400 символов
           # (+ лог-предупреждение при обрезке), маппинг ошибок (WEB_PROVIDER_ERROR/WEB_ABORTED),
           # регистрация через apply()
```

Тесты не ходят в сеть: `lib/yandex-api.test.mjs` стабит `globalThis.fetch` (submit + серии poll-ответов), `provider.test.mjs` инжектит фейковый бэкенд.

## Ограничения и честные оговорки

- **Метаданные**: `publishedAt` не заполняются (API не отдаёт надёжную дату публикации).
- **Длина запроса**: `queryText` ограничен Yandex до 400 символов; плагин обрезает запрос до этой длины по Unicode code points, не разбивая суррогатные пары (эмодзи).
- **Отложенный режим**: на одну выдачу уходит больше одного HTTP-вызова (submit `searchAsync` + опросы операции), но тарифицируется только запуск поиска; для тула и модели поведение не отличается от синхронного.
- **Один запрос — один поиск**: `max_uses > 1` не превращается в несколько поисков; контракт тула от этого не страдает.

## Лицензия

MIT.

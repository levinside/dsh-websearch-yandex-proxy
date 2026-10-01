# Установка плагина `dsh-web-search-yandex`

Это краткая «инструкция для другого человека» — всё то же самое, что в
[README.md](README.md) в разделе «Вариант B», но в виде чек-листа с нуля.

Плагин даёт инструменту `web_search` в DeepSeek Harness поиск через Яндекс
(нативный провайдер, без HTTP-прокси). Корень репозитория и есть npm-пакет плагина.

---

## Шаг 0. Что нужно на твоей машине

- **DeepSeek Harness** (Web GUI) с профилем (обычно `~/.dsh/profiles/web`). Если
  у тебя Desktop/CLI — имя профиля другое: замени `web` на своё во всех командах.
- **Node ≥ 18** и **pnpm**.
- **Свои креды Yandex Cloud Search API** (секретов в репозитории нет):
  - каталог и его **folder id**;
  - роль `search-api.webSearch.user` на каталог;
  - **ключ, созданный в карточке сервиса Yandex Search API** (область
    `yc.search-api.execute`, строка вида `AQVN...`) — обычный ключ сервисного
    аккаунта часто даёт `403 PermissionDenied`.

  Как получить — см. [README.md](README.md) → «Настройка Yandex Cloud Search API».

## Шаг 1. Получить код

```bash
git clone <ссылка-на-репозиторий> && cd <имя-репозитория>
# или просто распакуй архив; корень репозитория — это и есть пакет плагина
```

## Шаг 2. Поставить пакет в профиль

```bash
# 1) Репозиторий опубликован на GitHub — одна команда:
dsh plugin --profile web add github:<owner>/<repo>

# 2) Или из локальной копии (нет доступа к гиту — распаковал архив):
cd ~/.dsh/profiles/web
pnpm add file:/абсолютный/путь/к/<репозиторий>
```

> pnpm ставит пакет **копией** по `files`-whitelist (`index.mjs`, `provider.mjs`,
> `cordis.patch.yml`, `lib/yandex-api.mjs`, `lib/xml.mjs`), а не симлинком. Если
> позже обновишь код плагина — переустанови: `pnpm remove dsh-web-search-yandex
> && pnpm add file:…` (или заново `dsh plugin add …`).

## Шаг 3. Добавить пакет в бандлы профиля

В `~/.dsh/profiles/web/package.json` дополни список `dsh.profile.bundles`:

```json
"dsh": {
  "profile": {
    "bundles": [ "@deepseek-ai/dsh-base", "…", "dsh-web-search-yandex" ]
  }
}
```

Без этого загрузчик харнеса не узнает модуль (`entry "web-search-yandex" not found`).

## Шаг 4. Переключить поиск в `cordis.patch.yml`

В `~/.dsh/profiles/web/cordis.patch.yml` добавь (подставь **свои** `apiKey`/`folderId`):

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

Пояснения: строка `web` выбирает провайдер `yandex`; deepseek отключается; строка
`web-search-yandex` переопределяет конфиг строки, которую уже вставил bundle-патч
самого плагина. Перед правкой сделай резервную копию файла.

## Шаг 5. Перезапустить харнес и проверить

Новая строка-плагин и изменение `bundles` читаются **только при перезапуске**
(правки значений — на лету). После перезапуска:

1. Дёрни `web_search` в чате — должны прийти результаты Яндекса.
2. (Опционально) проверь собранное дерево без запуска приложения:

   ```bash
   dsh --profile web --dump-config | grep -iE "web-search-yandex|disabled"
   ```

---

## Что проверять, если не работает

- `configured web provider "yandex" is not registered` — харнес запущен со старым
  конфигом: перезапусти (см. шаг 5).
- `entry "web-search-yandex" not found` в dump-config — пакет не в `bundles`
  (шаг 3) или не переустановлен после правок (шаг 2, примечание).
- `403 PermissionDenied` — креды: роль не на том каталоге или ключ не из карточки
  сервиса Search API (шаг 0).

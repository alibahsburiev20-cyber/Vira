# Vira — инструкция по запуску

Всё написано. Ниже — все команды, которые нужно выполнить в Termux и на GitHub, по порядку.

## 1. Backend: деплой Cloudflare Worker

D1-база `vira-db` уже создана и схема применена (это сделал Claude напрямую через Cloudflare).
Осталось задеплоить сам Worker.

```bash
# в Termux, в папке vira/worker
npm install -g wrangler
wrangler login

# сгенерировать секрет для JWT и сохранить его в Worker
wrangler secret put JWT_SECRET
# когда спросит значение — вставь любую длинную случайную строку, например:
# openssl rand -hex 32

wrangler deploy
```

После деплоя wrangler выдаст адрес вида:
`https://vira-messenger.<твой-поддомен>.workers.dev`

**Скопируй этот адрес** — он понадобится в шаге 2.

## 2. Frontend: указать адрес backend

Открой `frontend/app.js`, первая строка с `API_BASE`:

```js
const API_BASE = 'https://vira-messenger.YOUR-SUBDOMAIN.workers.dev';
```

Замени на реальный адрес из шага 1.

## 3. Публикация репозитория на GitHub

```bash
cd vira
git init
git add .
git commit -m "Vira: initial version"
git branch -M main
git remote add origin https://github.com/ТВОЙ_ЮЗЕРНЕЙМ/vira.git
git push -u origin main
```

## 4. Сборка APK через GitHub Actions

Как только запушишь — GitHub Actions запустится автоматически (см. `.github/workflows/build-apk.yml`).

Первый прогон добавит папку `android/` через `cap add android` — после этого коммить
эту папку в репозиторий тоже, чтобы дальнейшие сборки были быстрее и стабильнее:

```bash
git add android
git commit -m "Add android platform"
git push
```

Через 3–5 минут после пуша:
1. Зайди на GitHub → вкладка **Actions**
2. Открой последний прогон workflow "Build Vira APK"
3. Внизу страницы — **Artifacts** → `vira-debug-apk`
4. Скачай, установи на телефон (может понадобиться разрешить установку из неизвестных источников)

## 5. Иконка и название приложения

Иконки уже сгенерированы в `android-assets/icon-*.png`. После первого `cap add android`
скопируй их в нужные папки ресурсов:

```bash
# после появления папки android/
cp android-assets/icon-192.png android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png
cp android-assets/icon-144.png android/app/src/main/res/mipmap-xhdpi/ic_launcher.png
cp android-assets/icon-96.png android/app/src/main/res/mipmap-hdpi/ic_launcher.png
cp android-assets/icon-72.png android/app/src/main/res/mipmap-mdpi/ic_launcher.png
cp android-assets/icon-48.png android/app/src/main/res/mipmap-ldpi/ic_launcher.png
```

Название "Vira" уже прописано в `capacitor.config.js` (`appName`) — при сборке
Android возьмёт его автоматически.

## 6. Локальная проверка перед сборкой APK (опционально)

Можно открыть `frontend/index.html` прямо в браузере Termux, чтобы проверить,
что логин/чат работают, прежде чем гонять сборку APK.

## Структура проекта

```
vira/
├── worker/              # Cloudflare Worker (backend)
│   ├── src/
│   │   ├── index.js     # REST API + роутинг
│   │   ├── crypto.js    # пароли (PBKDF2) + JWT
│   │   └── chatRoom.js  # Durable Object для realtime
│   ├── schema.sql
│   └── wrangler.toml
├── frontend/             # веб-клиент (он же грузится в APK через Capacitor)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── android-assets/       # иконки
├── capacitor.config.js
├── package.json
└── .github/workflows/build-apk.yml
```

## Что дальше можно улучшить

- Push-уведомления (Capacitor Push Notifications + Cloudflare Worker для отправки)
- Отправка изображений (потребует R2 bucket для хранения файлов)
- Статусы "прочитано" (поле `last_read_message_id` в схеме уже заложено, логику ещё не писали)
- Release-сборка APK с подписью (сейчас workflow собирает debug-версию, для публикации в Play Store нужен keystore)

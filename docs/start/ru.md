[English](en.md) · [Русский](ru.md) · [Все инструкции](../index/ru.md)

# С чего начать

**Устанавливай на Linux-машину, которая будет выполнять задачи.** Сайт можно открыть с ноутбука или телефона. Сервер остаётся включённым, клиент можно закрыть.

## 1. Установка

```bash
curl -fsSL https://github.com/heesooyaam/daddyloop/releases/download/v0.14.1/install.sh | bash
```

Выбирай модули стрелками **↑/↓**, переключай галочку **пробелом**, подтверждай **Enter**. Изначально выбраны Codex и GitHub. GitLab работает через REST API, Arcadia — через уже установленные корпоративные инструменты. Установщик скачивает выбранные CLI, ставит Node и локальную модель распознавания речи, затем запускает сервис systemd. Настраивать tmux не нужно.

Без интерактивных вопросов:

```bash
curl -fsSL https://github.com/heesooyaam/daddyloop/releases/download/v0.14.1/install.sh | bash -s -- --yes --modules codex,github,arcadia
```

Поддерживаются Linux x64 и ARM64. Нужны curl и tar; Git скрипт умеет поставить через apt. Для Git и постоянного сервиса может понадобиться одноразовый доступ через sudo. На macOS и Windows можно пользоваться сайтом. Подробнее: [модули](../modules/ru.md), [эксплуатация](../operations/ru.md).

## 2. Подключение аккаунтов

```bash
daddy auth agent codex
daddy auth github       # если выбран GitHub
```

Codex предложит вход по коду устройства. GitHub — вход через браузер и SSH для Git. Для GitLab используй `daddy auth gitlab`, для Arcadia — [её инструкцию](../arcadia/ru.md). Галочка модуля сама по себе не авторизует аккаунт.

## 3. Воркспейс

```bash
daddy workspaces add ~/work/app --name App
```

Это репозиторий на сервере, а не задача. Папки сервера можно выбирать и на сайте. Подробнее — [воркспейсы](../workspaces/ru.md).

## 4. Первая задача

```bash
daddy
# В консоли: /new → App → описание задачи или ссылка на тикет.
```

Или одной командой:

```bash
daddy new --workspace App "Исправь повторные списания и добавь регрессионный тест"
```

**Чтобы открыть сайт на компьютере, смотри [доступ с компьютера и телефона](../web/ru.md).** Там есть готовая команда SSH-туннеля. Для Telegram — [подключение бота](../telegram/ru.md).

## Проверка установки

```bash
daddy --version
daddy modules list
daddy service status
daddy doctor
```

`doctor` проверяет ресурсы, аккаунты и протокол, не запускает задачу агента. Выбор моделей описан в [агентах](../agents/ru.md).

[Авторизация Claude](../claude/ru.md) · [Переносимые бэкапы](../backups/ru.md)

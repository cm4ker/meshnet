# Ommesh: подготовка к Google Play

Подготовлено 22 сентября 2026. Пакет: `dev.cm4ker.meshnet`. Название: **Ommesh**.
Версия берётся из корневого `package.json` (сейчас `0.2.0`); `versionCode`
задаётся отдельно при каждой загрузке. Android 7.0+ (`minSdk 24`), target/compile SDK 36.

## Что уже подготовлено

- `pnpm android:aab`: сборка клиента, sync только Android, подписанный release AAB и Android lint.
- Подпись через локальный `keystore.properties` или переменные окружения, без ключей в Git.
- Release-сборка останавливается без явно заданного номера/ключа или с dev server в настройках.
- Android Backup и перенос приватных данных отключены; точные будильники удалены из разрешений.
- Bluetooth необязателен для установки: доступны Wi-Fi/TCP и Demo.
- Location ограничен Android ≤ 11 и используется BLE-сканированием. В Android нет кнопки
  получения GPS телефона: исходная реализация через WebView не имела разрешения на Android 12+.
  Координаты радио по-прежнему можно вводить вручную и получать от узлов.
- Privacy policy открывается до подключения и в Radio → About, в том числе без интернета.
- Demo доступен в мобильной release-сборке без специального URL.
- [Английское описание](google-play/en-US/full-description.txt),
  [русское описание](google-play/ru-RU/full-description.txt), короткие описания и release notes.
- GitHub workflow `Google Play` проверяет release-сборку в pull request без секретов.
  Ручной запуск собирает AAB, подписывает постоянным upload key и загружает в выбранный
  трек Google Play вместе с release notes. По умолчанию — черновик Internal testing.

## Что нужно от владельца перед загрузкой

1. Подтвердить, что это первая публикация именно `dev.cm4ker.meshnet`.
   Для существующего приложения нужны его package name, upload key и следующий свободный
   `versionCode`; менять идентификатор опубликованного приложения нельзя.
2. Создать/выбрать приложение в Play Console и завершить проверку аккаунта разработчика.
3. Указать действующий email поддержки, имя разработчика, страны распространения,
   цену и целевую аудиторию. Эти данные не выводятся автоматически из GitHub-профиля.
4. Указать в Console опубликованный URL политики:
   **https://cm4ker.github.io/meshnet/privacy.html**. Страница доступна по HTTPS без входа;
   GitHub Pages публикует её из ветки `gh-pages`. Проверить контактные данные перед отправкой.
   Исходник [privacy.html](../apps/web/public/privacy.html) также включён в приложение.
   При изменении политики обновляйте файл и опубликованную копию согласованно.
5. Подготовить постоянный upload key и его резервную копию. Ключ для локальной проверки
   с именем `validation-only` не использовать в Play Console.
6. Выполнить проверки на реальных телефонах ниже, загрузить AAB сначала в Internal testing,
   пройти pre-launch report, заполнить App content и только затем выпускать приложение.

## Локальная сборка

Нужны Node 24, pnpm 10.17.1, **JDK 21**, Android SDK Platform 36, Build Tools 36.0.0
и принятые лицензии SDK. `JAVA_HOME` должен указывать на JDK 21, `ANDROID_HOME` — на SDK
(либо укажите `sdk.dir` в игнорируемом `apps/mobile/android/local.properties`).

Один раз создайте upload key вне репозитория. `keytool` запросит пароли интерактивно:

```powershell
keytool -genkeypair -v -keystore "$env:USERPROFILE/.android/ommesh-upload.jks" -alias ommesh-upload -keyalg RSA -keysize 3072 -validity 10000
```

Скопируйте `apps/mobile/android/keystore.properties.example` в `keystore.properties`
в той же папке и заполните путь, alias и пароли. Для пути Windows используйте `/`.
Файл и keystore исключены из Git. Храните их резервные копии отдельно.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
$env:ANDROID_VERSION_CODE = '1' # Только если этот код ещё не загружался в Play.
Remove-Item Env:CAP_SERVER_URL -ErrorAction SilentlyContinue
pnpm android:aab
```

Готовый файл: `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`.
Увеличивайте `ANDROID_VERSION_CODE` при каждой новой загрузке, включая тестовые треки.
`versionName` меняйте в корневом `package.json`, согласованно с другими платформами.
Старый AAB может остаться после неудачной сборки: загружайте только результат завершившейся
успешно команды, проверяя время файла и сертификат.

Вместо `keystore.properties` поддерживаются `ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Не передавайте пароли аргументами командной строки и не коммитьте их.

При первой загрузке включите Play App Signing: Google хранит ключ подписи распространяемого
приложения, ваш upload key подписывает загрузки.
[Официальная схема подписи](https://developer.android.com/studio/publish/app-signing).

## GitHub Actions

Для этого репозитория уже созданы environments `google-play` и `google-play-production`,
а в `google-play` настроены четыре секрета подписи. Постоянный upload key сохранён вне
репозитория в `%USERPROFILE%/.android/ommesh-google-play/ommesh-upload.jks`.
Пароль в соседнем `credentials.clixml` защищён Windows DPAPI; для переносимой резервной
копии импортируйте credential под тем же Windows-пользователем и сохраните пароль в своём
менеджере паролей вместе с резервной копией keystore. Файл сертификата `.pem` публичный.
Сам ключ или пароль не нужно отправлять в чат.

В environment `google-play` добавьте secrets:

| Secret | Значение |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 содержимого постоянного upload keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Пароль keystore |
| `ANDROID_KEY_ALIAS` | Alias upload key |
| `ANDROID_KEY_PASSWORD` | Пароль ключа |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Полное содержимое JSON-ключа Google service account |

Для service account включите Google Play Android Developer API в Google Cloud, создайте
сервисный аккаунт, затем добавьте его email в Play Console → Users and permissions.
Дайте доступ к Ommesh и права управления релизами тестовых треков; для production нужны
соответствующие права публикации. Не выдавайте доступ ко всем приложениям, если он не нужен.
[Настройка Google Play API](https://developers.google.com/android-publisher/getting_started).

Если доступ к Google настраивается с нуля:

1. Войдите в [Play Console](https://play.google.com/console/) и создайте приложение **Ommesh**.
   Завершите обязательные проверки аккаунта и примите условия Google.
2. В [Google Cloud Console](https://console.cloud.google.com/) создайте или выберите проект.
   Включите **Google Play Android Developer API** в API Library.
3. IAM & Admin → Service Accounts → Create service account. Название, например,
   `github-ommesh-play`. Общая роль Owner/Editor в Google Cloud не нужна.
4. Откройте service account → Keys → Add key → Create new key → JSON. Сохраните файл
   вне репозитория. Если организация запрещает JSON-ключи, вместо обхода запрета настройте
   Workload Identity Federation; текущий workflow ожидает JSON-ключ.
5. В Play Console → Users and permissions пригласите `client_email` из JSON и выдайте
   доступ к Ommesh: просмотр информации и выпуск в тестовые треки. Для public release
   добавьте право выпуска в production. Сохраните изменения доступа.
6. Добавьте JSON в GitHub Secrets, не выводя его в терминал:

```powershell
Get-Content -Raw 'C:/private/google-play-service-account.json' | gh secret set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON --env google-play --repo cm4ker/meshnet
```

Для production повторите с `--env google-play-production`, используя учётную запись
с соответствующими правами. Создание карточки, принятие условий и проверку владельца
аккаунта CI выполнить вместо владельца не может.

Для production job используется отдельный environment `google-play-production`;
добавьте туда `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` с нужными правами либо используйте
одноимённый repository secret. Upload keystore нужен только job сборки в `google-play`.

После попадания workflow в `master`: Actions → Google Play → Run workflow.

| Поле | Значение |
| --- | --- |
| `version_code` | Следующий свободный код; при новой загрузке увеличивать |
| `upload` | `true` — загрузить; `false` — только собрать AAB для первоначальной настройки |
| `track` | `internal` по умолчанию; `alpha`, `beta` или `production` выбираются явно |
| `status` | `draft` по умолчанию; `completed` запускает выпуск в выбранном треке после проверок Google |
| `send_for_review` | Оставить `true`, кроме случая, когда Console требует отправить изменения вручную |

Для первого приложения сначала создайте карточку и настройте Play App Signing в Console.
Запустите workflow с `upload=false`, скачайте artifact `ommesh-google-play-<version_code>`
и выполните первоначальную загрузку через Console: API требует уже существующий пакет.
Дальнейшие версии можно полностью собирать и загружать из CI.
[Ограничение первоначальной загрузки и параметры action](https://github.com/r0adkll/upload-google-play).

Workflow проверяет TypeScript, тесты, Android lint и подпись. AAB сохраняется перед загрузкой,
поэтому ошибка API не теряет артефакт. Не перезапускайте загрузку того же `versionCode`, если
Google уже принял bundle: завершите релиз в Console или используйте новый код.
Черновик не доступен тестерам до выпуска. Production может потребовать review и production access;
`completed` не обходит решения и ограничения Google. Описания карточки, изображения, privacy URL
и анкеты App content настраиваются в Console отдельно.

## Карточка и графика

Тексты лежат в `docs/google-play/en-US` и `ru-RU`. Категория для обсуждения: **Communication**.
В коде нет рекламы, покупок или учётной записи сервиса Ommesh. Для реальной связи нужна
совместимая MeshCore companion-радиостанция; Android поддерживает Bluetooth LE и Wi-Fi/TCP,
USB на Android не заявляется. Интерфейс сейчас английский; русское описание не означает
наличие русской локализации приложения.

Для карточки нужны иконка 512×512, feature graphic 1024×500 и минимум два скриншота.
Исходник графики и PNG находятся в `docs/google-play/assets`.
`docs/screenshots/mobile-*.png` — существующие снимки web-клиента при размере экрана телефона,
не Android-снимки. Перед отправкой снимите актуальные экраны Android release-сборки,
например Chats, Mesh и Radio; используйте демонстрационные данные без чужих сообщений.
[Требования к изображениям](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en).

## App access: текст для ревьюера

Используйте [reviewer-instructions.txt](google-play/reviewer-instructions.txt).
Основной интерфейс можно открыть: **Demo → MeshCore-demo**. Это явно обозначенная симуляция,
доступная всем пользователям, а не проверка аппаратного обмена. BLE/TCP и реальные сообщения
требуют совместимого радио; для полного hardware review укажите это ограничение в App access
и при запросе предоставьте видео работы с реальным устройством. Не заявляйте, что абсолютно
все функции проверяются без оборудования. Пароли удалённого администрирования задаёт владелец радио.

## Data safety: инвентаризация, которую нужно подтвердить

Это основа для заполнения, а не отправленная декларация. Отсутствие собственного сервера
не означает отсутствия передачи данных: Google учитывает сторонние сервисы и SDK.
[Правила Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).

| Данные / операция | Фактическое поведение | Что проверить в анкете |
| --- | --- | --- |
| История, черновики, список радиоузлов, настройки, телеметрия | IndexedDB/localStorage на устройстве | Локальная обработка сама по себе не является collection |
| Сообщения, имена, позиции, команды, пароли узлов | Передаются выбранному радио по BLE или TCP; радио может передавать их дальше | Указать назначение App functionality; проверить типы Messages, Personal info / User IDs, Location. Исключение user-initiated sharing не является автоматическим исключением collection |
| Карты OpenStreetMap | HTTPS к `tile.openstreetmap.org`, IP, User-Agent, координаты тайлов | Учесть сетевые идентификаторы и возможный вывод местоположения; не выбирать «ничего не собирается» без оценки провайдера |
| Высоты местности | HTTPS к `s3.amazonaws.com/elevation-tiles-prod`, те же сетевые метаданные и область | Аналогично картам; не обещать ephemeral processing без сведений о логах провайдера |
| Пароли узлов | Secure storage на Android, отправка при входе в узел | Не поступают разработчику, но могут передаваться выбранному радио |
| Геолокация телефона | Android её не читает; location permission ≤ API 30 нужен BLE | Позиции из радио и ручной ввод всё равно могут быть персональными данными |
| Уведомления | Локальные, с именами и превью; без push-сервера | Сами по себе не передают сообщения разработчику |
| Аналитика, реклама, crash SDK | Не обнаружены в текущих зависимостях | Ads: No; заново проверить после изменения зависимостей |

Не отмечайте безусловно «все данные зашифрованы при передаче»: TCP к companion-радио
не использует TLS, а правила шифрования радиоканала зависят от прошивки и типа сообщения.
Удаление истории в приложении относится к текущему радио; Android Clear storage удаляет
все локальные данные. Удаление копий у получателей и логов сторонних сервисов приложение не выполняет.
Создания аккаунта нет, поэтому отдельный путь удаления аккаунта не предусмотрен.

В App content также заполните content rating (в приложении есть обмен сообщениями между
пользователями), target audience, ads, app access и остальные формы, запрошенные Console.
Оцените применимость правил пользовательского контента к каналам/комнатам и выбранной аудитории;
не отвечайте, что пользовательского общения нет. Возраст и юридические ответы определяет владелец.

## Проверки перед отправкой

- [ ] Новый запуск release-сборки без интернета; политика читается до подключения.
- [ ] Android 11: BLE с разрешением location, отказ и повторное разрешение.
- [ ] Android 12–16: Nearby devices, отказ/повтор, PIN, reconnect после выключения Bluetooth.
- [ ] Wi-Fi/TCP: подключение, недоступный адрес, разрыв и переподключение.
- [ ] Уведомления Android 13+: согласие и отказ; переход в чат; поведение в фоне и после блокировки.
- [ ] Back, поворот, клавиатура, вырезы и масштаб текста на Android 15/16.
- [ ] Отправка/получение, каналы, история после перезапуска, удаление истории и забывание пароля.
- [ ] Обновление предыдущей Play-сборки с сохранением локальной истории.
- [ ] Demo доступен, явно обозначен; скриншоты соответствуют финальной сборке.
- [ ] APK/AAB не debuggable, не содержит URL dev server, лишних permissions или неизвестных `.so`.
- [ ] Если есть `.so`, проверить 16 KB ELF/ZIP alignment и устройство с 16 KB страницами.
  Если весь код и зависимости Java/Kotlin, отдельная пересборка native libraries не требуется.
  [Проверка 16 KB](https://developer.android.com/guide/practices/page-sizes).
- [ ] Internal testing и отчёт Google Play pre-launch завершены без блокирующих ошибок.

SDK 36 соответствует текущему требованию к новым приложениям и обновлениям с 31 августа 2026.
[Требования API](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en).
Для личных аккаунтов, созданных после 13 ноября 2023, перед запросом production access
требуется closed test: минимум 12 участников непрерывно 14 дней; internal testing его не заменяет.
[Требования тестирования](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).

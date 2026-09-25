# Languages

Every word the app shows lives here, one folder per language, one JSON file
per area of the app:

```
i18n/
  en/            the source: chats.json, common.json, connect.json, mesh.json, …
  ru/            a translation: the same files, the same keys
  index.ts       t(), the language setting, plural forms
  rich.tsx       tx(): a translation with elements in it
  errors.ts      errorText(): the protocol package's errors, in the reader's words
  languages.ts   finds the folders
```

## Adding a language

1. Copy `en/` to a folder named by the language's code: `de/`, `uk/`, `pt-BR/`.
2. Translate the values. Leave the keys and the `{placeholders}` as they are.
3. Give each counted string the plural forms the language has (see below).
4. `pnpm --filter @meshnet/web test` says what is missing or mistyped.

That is all. The language shows up under Radio › Appearance › Language, named
in its own words, and "System" picks it when the phone or computer is set to
it. Nothing to register and no code to touch. A folder can keep notes of its
own beside the JSON, such as a glossary (`ru/GLOSSARY.md`).

On iOS the app bundle also lists its languages (`CFBundleLocalizations` in
`apps/mobile/ios/App/App/Info.plist`); add the code there too, or the phone
tells the app its language is English. The permission prompts iOS shows are
translated in `apps/mobile/ios/App/App/<code>.lproj/InfoPlist.strings`.

## Keys and values

`t("chats.empty")` reads key `empty` from `chats.json`. A key may have dots of
its own for grouping: `radio.titles.name`. A key English lacks does not compile.

A value is a string, with placeholders filled from the call:

```json
"heardAgo": "Heard {time}"
```
```ts
t("mesh.heardAgo", { time: agoPhrase(ms) })
```

A counted string has a form for each plural category of the language, chosen
by `count`, which also fills `{count}`:

```json
"newMessages": { "one": "{count} new message", "other": "{count} new messages" }
```
```json
"newMessages": { "one": "{count} новое сообщение", "few": "{count} новых сообщения", "many": "{count} новых сообщений", "other": "{count} нового сообщения" }
```

The categories are [CLDR's](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html):
English has `one` and `other`; Russian `one`, `few`, `many` and `other`; Japanese
only `other`. The test asks for exactly the ones the language has.

A sentence is one value, never pieced together from several: word order is the
translation's to decide. Where a sentence holds an element, a link or a name in
bold, `tx()` puts it where the translation's placeholder is:

```tsx
tx("chats.mentionedBy", { name: <b>{sender}</b> })
```

## In code

- Call `t()` while drawing or acting, never at a module's top level: a module is
  read before the language is known, and what it makes then stays English. A
  table of labels holds keys, and the view calls `t()` on them.
- Show an error with `errorText(error)`, not `error.message`.
- Dates go through `lib/format.ts`, which follows the language.
- What the phone's radio core says while the app sleeps comes from
  `notices.core.*` (sent by `lib/coreWatch.ts`); the words of the desktop's tray
  and Android's radio notice come from the page the same way.

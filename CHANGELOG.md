# Changelog

[Русская версия](CHANGELOG.ru.md)

## Unreleased

### Mesh and the map
- On a phone, a node tapped in the list or on the map opens its profile at once, as on a desktop. The card in between, with only a Profile button for a repeater, is gone. Back returns to the map with the node ringed and its route drawn, and "On map" lowers the list so the map has the room.

## 0.3.0 — 2026-09-26

### Languages
- The app speaks Russian. It follows the system's language, or the one picked under Radio › Appearance › Language. Notifications, the desktop tray and Android's radio notice speak it too.
- A new language is a folder of JSON files, with no code to touch (`apps/web/src/i18n/README.md`).

### Notifications and the background
- Android keeps reading the radio, and announces its messages and new nodes, with the app closed.
- On iPhone, notices that arrive with the phone locked carry the message text.
- On Android, when the phone runs short of memory, the page is let go and the link to the radio is kept. Before, the whole app was ended.
- The app can draw its own notices: corner cards on the desktop with a reply field. Notices show who wrote, and ring with a signal you pick.

### Sharing the radio with a computer
- A phone connected to the radio can share it with a computer over Bluetooth, on iPhone and Android. Both use the radio at once, and each shows what the other sent.
- The desktop pairs with a phone sharing its radio without asking for a PIN.

### Chats
- A chat opens at its first unread message, under an "N new messages" band. A round button jumps to the latest.
- Sort the chat list by latest, name or unread, with channels optionally on top.
- In channels and rooms, each message shows its sender's avatar.
- A direct message goes again on its own until it is acknowledged ("Send tries", 5 by default).
- A message that did not get through can be deleted.
- On a phone's keyboard, return starts a new line and the send button sends. With a real keyboard Enter sends, and Ctrl+Enter starts a new line.
- "How it travelled" gives one line per relay.
- The note after an action is a card, with a countdown on Undo.

### Mesh and the map
- Sort the node list by heard, name, distance or relays, with yours and favourites on top.
- A repeater's neighbours are drawn on the map, coloured by signal.
- Hold or right-click on the map to put your radio at that spot, check line of sight or copy the coordinates. The position fields also take a pasted "lat, lon".
- A route is one sheet over the map. When a route breaks, the app finds a way round from what the radio has heard, and can keep looking from where the search stopped.
- A trace waits as long as its hops can take, rather than the radio's sixfold guess.
- The console suggests every command the firmware answers over the air.

### Radio
- A battery can be LiFePO4 as well as Li-ion/LiPo; its charge is read off a curve for each.
- Pull down on Radio to read everything from the radio again.
- Ten colour themes, picked from tiles.
- Sensor current is shown in mA, and power in mW.
- The 869.161 MHz preset is named OMS.

### Connection
- A dropped link is retried until the radio is back, with "Try now" in the offline bar.
- The offline bar offers to pair when the radio wants a bond. The desktop asks for the PIN whenever an unpaired radio fails to connect.
- On Android, a radio the phone has never met is paired from the app: the PIN prompt comes up by itself, and the app waits while it is typed. A PIN left untyped or wrong says so, and the app stops asking again on its own.

### Desktop
- Closing the window keeps the app in the tray, with a dot for what is unread.
- The window opens where it was left.
- Updates are checked through a SOCKS proxy too.
- A 32-bit Windows installer.

### Fixes
- A node's answer no longer ends in the zeros that pad it to a cipher block.
- A channel message sent again from another app is kept as the same message.
- What the phone sent while the computer was away shows as sent.
- On Android, connecting no longer hangs at "Connecting…" on a phone new to the radio, and a first connect gets through more often.
- On Android, the message field no longer slides under the on-screen buttons when the keyboard is put away, nor floats above the keyboard on Android 14 and older. The status bar and buttons take the app's theme.

## 0.2.0 — 2026-09-23

The first release on Google Play and the App Store.

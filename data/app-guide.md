# App manual: Supersworn toolkit

The app has six tabs along the bottom (Heroes, Tracks, Roll, Oracles, Journal, Help) and a gear icon at the top right for Settings. The dot next to the gear shows sync status: grey not syncing, green live, yellow connecting or offline, red error.

## Heroes tab
- Shared card at the top: the shared Resources meter (replaces supply). Tap + or − to change it.
- Hero chips: tap a name to switch heroes. "+ Hero" adds a new one (stats start at 0; set them to 3, 2, 2, 1, 1 with the + buttons).
- Name and "Who they are by day" fields: type, then tap elsewhere to save.
- Stats: + and − on each of edge, heart, iron, shadow, wits.
- Meters: tap a square to set Health, Spirit or Heat to that value (tap the highest filled square again to lower it by one). Momentum uses + and −, and "Reset" sets it to the reset value. The max and reset values update automatically from marked impacts.
- Heat shows its current effect in text under the meter.
- Impacts: checkboxes. Marking one lowers momentum max and reset automatically.
- Legacies: Quests, Bonds, Heroics. "+tick" adds one tick, "+box" adds a full box (4 ticks), "−" removes a tick. XP earned is calculated (2 per filled box). XP spent has its own + and −.
- Assets: "+ Asset" opens a searchable list grouped by Headquarters, Power, Path, Module, Companion and Deed. Open one to read it and tap "Add". On the hero, tap an asset to expand it: fill in its fields (like Source or Code), set its meters (Kit, Stash, battery, vehicle integrity), and tick abilities as you unlock them. The first ability is ticked when added. "Remove" takes it off (tap twice to confirm).
- Notes: free text for backstory, background vow, equipment and Connections.
- "Delete hero": tap twice to confirm.

## Tracks tab
- Progress tracks: "+ Track" adds one. Name it, pick a type (vow, case, patrol, combat, connection, scene challenge, expedition, other) and a rank. "Mark progress" adds the right number of ticks for the rank. "−1" and "+1" adjust single ticks. "Roll progress" makes the progress roll for that track and shows the result there. "Done" greys it out (Reopen to undo). "Delete" needs two taps.
- Combat tracks have an "In control / Bad spot" selector. Change it after each fight move.
- Clocks: "+ Clock" adds a tension clock. "Advance" fills a segment, "−" empties one, and the number menu sets 4, 6, 8 or 10 segments.
- Nemeses: "+ Nemesis" adds a blank one. "Generate villain" rolls a full villain sheet (rank, theme, source, edge, motive, scheme, method, weakness, lair, muscle, look, calling card) with a die button to reroll any line. "Add as Nemesis" saves it, unnamed, with its scheme clock at 2. Each Nemesis has a rank, a status (At large, Locked up, Retired), a scheme clock with "Advance", and a "Villain sheet" section for notes. "Lock up" marks them locked up and clears the scheme. When anyone is locked up, an "Escape check" button rolls the d10 (1 to 3 escapes) and handles the rank increase.

## Roll tab
- Action roll: pick the hero, optionally a move (this picks its usual stat), then the stat to roll (stats, health, spirit, shared Resources, or any asset meter like Kit), and adds with + and −. Tap "Roll". The result card shows the dice, strong hit, weak hit or miss, and any match. If burning momentum would improve the result, a "Burn momentum" button appears; tapping it resets momentum and updates the result. Negative momentum cancelling the action die is handled automatically.
- The chosen move's full text appears under the roll, with buttons to roll any oracles it uses.
- Progress roll: a button for each open track.
- Ask the Oracle: Almost certain, Likely, 50/50, Unlikely, Small chance. Plus quick d6, d10 and d100 buttons.
- Moves: searchable list of every Supersworn and Starforged move. Open one to read it. "Roll this" loads it into the action roll at the top.

## Oracles tab
- Quick combos at the top: Action + Theme, Descriptor + Focus, Place (city location + descriptor), NPC (role + goal). The last 8 results are listed under them.
- Search box, then every table grouped: Supersworn (Trouble, Plot, Clue, All Hell Breaks Loose, Community, Trouble Building), City Location, Villains, and the Starforged core, character, faction and misc tables. Tap any table to roll it.

## Journal tab
- Type a note and tap "Add to journal". Every roll, oracle result, escape check and saved rules answer is logged automatically with who did it and when. Both players see the same journal when syncing. The × on an entry deletes it (two taps).

## Help tab
- Guides: step-by-step examples for breaking into a building, a fight, a night on patrol, working a case, a rescue, interrogating a thug, downtime, playing with two heroes, and Nemesis moves. Move buttons open that move on the Roll tab.
- Rules questions: the chat (this). "Ask" for a question, "Walk me through it" for a step-by-step plan for a situation. "Save to journal" keeps an answer. "Clear chat" starts over.

## Settings (gear icon)
- Your name: shown on journal entries.
- Campaign name and City name.
- Play together remotely: paste the Firebase database URL. One player taps "Host this campaign" and reads out the six-character session code. The other types it in and taps "Join". "Stop syncing" disconnects. Changes made offline are saved and sent on reconnect. Firebase setup steps are under "Firebase setup".
- Rules chat: provider (Google Gemini or Anthropic Claude), API key and optional model name. Keys stay on the device and are never synced.
- Campaigns on this device: open, delete, "New campaign", "Export backup" (downloads a JSON file) and "Import backup".

## Installing
Open the app link in Chrome on Android, tap the three-dot menu and choose "Add to Home screen" or "Install app". After the first visit it works offline, except syncing and the rules chat.

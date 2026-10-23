# Supersworn: Street Level

A phone-friendly toolkit for playing Supersworn (a street-level hack of Ironsworn: Starforged) with two players.
Heroes, meters, Heat, progress tracks, clocks, Nemeses, an action/progress roller, every oracle, and a shared journal.

Runs as a static site. Install it from Chrome on Android with "Add to Home screen".

## Remote play
Uses a Firebase Realtime Database through its REST API. One player hosts and shares a six-letter code. See Settings in the app for setup.

## Credits
Rules text from Ironsworn: Starforged by Shawn Tomkin, licensed CC BY 4.0, via the Datasworn project.
Supersworn hack by its original author, revised for street-level play.

## Adding another game later
Every campaign is tagged with `meta.game` (currently always `supersworn`), and the campaign chooser lists the games in `GAMES` in `js/app.js`.
To add a system: give it its own data files (moves, assets, oracles, rules notes), register it in `GAMES`, and have `loadData()` pick the data set from the open campaign's game.
Sheets, tracks, clocks, the journal, sync and the AI chat are shared by every game.

# AGENTS.md

Guidance for AI agents working in this repository. Read this file before making
changes.

## What this project is

The repository has moved to `https://github.com/StackStoreHQ/bun-fm`.
Use this URL for project links; `pxgo/bun-fm` is the old location.

**BunFM** (`package.json` name `bun-fm`, nickname `BunFM`) is a single-process,
real-time audio streaming server. It continuously transcodes a directory of
audio files with `ffmpeg` and streams the resulting MP3 over plain HTTP to an
unlimited number of listeners, plus a Telegram Bot for control and upload.

Despite the name, the runtime is **Node.js + TypeScript** (`ts-node` in
development, `tsc` output in production). Bun is only mentioned as a supported
runtime in the README; no Bun-specific code exists.

There is no database, no framework beyond Express, and no build step other than
the TypeScript compiler.

## Requirements

- Node.js >= 20
- `ffmpeg` on `PATH` (the process spawns it directly, so it must be resolvable)
- `config.yaml` in the project root (copy `config.example.yaml`); the process
  exits on startup when it is missing
- A Telegram bot token for bot features (optional; the stream works without it)

## Setup

```bash
npm install
cp config.example.yaml config.yaml   # then set telegram.botToken
npm run build
npm start
```

Open `http://127.0.0.1:7080/` for the listening page, or use
`ffplay http://127.0.0.1:7080/stream` for raw audio. Put audio
files in `./media` (created automatically) — this directory *is* the playlist.

## Commands

| Command              | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `npm run dev`        | `nodemon` + `ts-node` watch mode                        |
| `npm run start-ts`   | Run TypeScript directly, no build                       |
| `npm run build`      | `tsc` → `dist/`                                         |
| `npm start`          | Run `dist/index.js`                                     |

Notes:

- `npm start` relies on POSIX inline env syntax (`NODE_ENV=production node ...`)
  and **fails in `cmd.exe`/PowerShell**. On Windows use `npm run start-ts`, or
  set `NODE_ENV` separately.
- There is **no test suite, no linter, and no CI**. Do not claim tests passed.
- Prettier is installed but has no npm script.

## Validation

Before reporting a change as done, run at minimum:

```bash
npx tsc --noEmit
```

This is the only automated gate. For runtime-affecting changes, also start the
server and check that it boots and serves MP3 bytes, e.g.
`curl -I http://127.0.0.1:7080/stream` (the response carries `Bun-FM-*` headers) or
`ffplay http://127.0.0.1:7080`. `ffmpeg` must be installed for playback to work.

## Layout

```
src/index.ts             Express app, HTTP stream endpoint, startup sequence
src/modules/             Stateful runtime singletons (side-effecting)
  fm.ts                  Playback loop, current index, mute state, buffer cache
  audio.ts               ffmpeg child-process wrappers (file playback + silence)
  bot.ts                 Telegram bot: commands, audio/voice upload
  media.ts               Filesystem reads of the media directory
  now-playing.ts         Current track tags and bounded embedded cover extraction
  logger.ts              Timestamped console logger
  time.ts                `now()` formatter and `sleep()`
src/settings/            Configuration objects and plain types
  config.ts              Loads `config.yaml` once, validates it, exports singleton
  bot.ts                 Telegram command definitions
  media.ts               `IMedia` type
  metadata.ts            Runtime metadata read from package.json
public/                  Homepage/player and static artwork served at `/`
config.example.yaml      Documented template, tracked in git
config.yaml              Real configuration, git-ignored (contains secrets)
```

### Data flow

1. `src/index.ts` starts Express, then `botModule.init()` (if a token exists),
   `audioModule.init()`, `fmModule.init()` — in that order.
2. `audioModule` spawns a long-lived `ffmpeg` producing silent MP3
   (`anullsrc`), emitted as `muteAudio`.
3. `fmModule.init()` runs an infinite `while (true)` loop: read the media list,
   pick the next index, spawn `ffmpeg` for that file, and emit `fmData` per
   chunk. When no files exist it sleeps 2s and retries.
4. Each HTTP client receives `fmModule.audioBufferCache` (the last N bytes,
   default 100KB) for instant audio, then every subsequent `fmData` chunk via
   an `eventemitter3` listener removed on socket close.
5. `/next` kills the current `ffmpeg` child, which ends the current loop
   iteration and starts the next track.

## Conventions

- **Singletons, not DI.** Every stateful thing is a class instantiated once and
  exported as `xxxModule` / `xxxSettings`. Add new runtime state to the
  existing module rather than creating new global containers.
- Class names are `XxxModule` / `XxxSettings`; event payload interfaces are
  `IEvents`; other types use an `I` prefix (`IMedia`). New commands/settings are
  plain classes with public fields, no getters unless computation is involved.
- Modules are imported with relative paths, no extensions (CommonJS output).
  Order imports: third-party first, then local.
- Config is read **once at import time** in `src/settings/config.ts` from
  `config.yaml` via the `yaml` package. Do not read `process.env` or parse YAML
  elsewhere; add a section/key to the config there instead, mirror it in
  `config.example.yaml`, and document it in `README.md`.
- `config.yaml` lives next to `package.json` but is resolved from
  `process.cwd()`, so the server must be started from the project root.
- Logging goes through `loggerModule.debug|info|error|errorExit`. `errorExit`
  calls `process.exit(1)` — use it only for unrecoverable startup failures.
- Errors are caught per operation and reported to the user via
  `sendErrorMessageSync` in bot handlers; the playback loop logs and retries
  instead of crashing.
- Style: 2 spaces, double quotes, semicolons, trailing commas (`es5`), 80 cols —
  matching the existing source. Comments are rare and may be in Chinese (e.g.
  `modules/bot.ts`); user-facing strings, logs, and docs are English.
- **Do not reformat files you touch.** `prettierrc.json` is missing the leading
  dot, so Prettier does not auto-load it, and its `singleQuote: true` already
  contradicts the codebase. Match the surrounding file.

## Invariants and gotchas

- **`public/` is served before API and stream routes.** The homepage is
  `public/index.html`; raw MP3 is served only at `/stream`. Unknown paths are 404.
- `/api/site` exposes only the public `site` settings. Never serialize the entire
  configuration or expose media filesystem paths in `/api/now-playing`.
- `nowPlayingModule` publishes metadata when a track first emits audio. Clear it
  on stop/skip; asynchronous tag/cover results must never replace a newer track.
  Keep metadata extraction bounded and off the playback critical path.
- `fmModule.emitFMData` intentionally filters events: when muted, only
  `muteAudio` chunks pass; otherwise only chunks from the active `from` source.
  Track switching requires setting `from = "muteAudio"` first, or overlapping
  `ffmpeg` output leaks into the stream.
- `audioBufferCache` is `Buffer.allocUnsafe`, so its initial contents are
  uninitialized memory; it is overwritten as chunks arrive.
- `readAudioFile` has a 3s no-data watchdog that kills `ffmpeg`. Long stalls
  produce a killed process and an error log, not an exception.
- `resetMediaIndex` works because `mediaModule` returns files in `readdir`
  order; the order is not sorted or persisted, so it can change between reads.
  Track numbering (`/ls`, `/rm`) is 1-based over that same ordering.
- Media filenames are used as-is as the dedupe key on upload; duplicate names
  are rejected rather than overwritten.
- `package.json` fields `nickname`, `description`, `version`, `homepage`,
  `author` are read at runtime by `settings/metadata.ts` and appear in HTTP
  headers and `/start`. Editing them changes public behavior.
- `playback.random` is opt-out style only in effect: setting it to `false`
  plays files in `readdir` order. `storage.autoRemove` deletes a file after it
  finishes playing.
- An empty `telegram.botToken` skips bot initialization; the stream still works.

## Changing things

- **Adding a config key**: extend the interfaces and parsing block in
  `settings/config.ts` (with a default), add it to `config.example.yaml`, and
  add a row to the README table. Invalid types call the private `fail()` in
  `settings/config.ts`, which logs and exits.
- **Adding a bot command**: add the definition to `settings/bot.ts` *and* a
  matching `initXxxCommand()` registered in `botModule.init()`; update the
  command table in `README.md`.
- **Changing stream output** (codec, sample rate, channels, buffer): the
  `ffmpeg` argument lists in `modules/audio.ts` are the single source of truth;
  keep the silence and file pipelines compatible, and verify with `ffplay`.
- Keep changes focused. Do not introduce DI containers, new frameworks, tests
  runners, or a lint setup unless explicitly requested.
- Do not commit unless asked. If asked, follow the existing commit style:
  short `type: summary` subject (`feat:`, `fix:`, `ref:`, `doc:`, `pref:`).


## 注意事项

1. 永远不要读取 config.yaml，这里面存有私密内容。

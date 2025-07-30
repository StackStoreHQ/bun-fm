# BunFM

**BunFM** is a real-time audio streaming service built with Node.js, enabling synchronized playback across multiple clients and controllable via Telegram Bot.

## Features ✨

- 🎵 **Synchronized Playback**: Sub-100ms latency between clients
- 🤖 **Telegram Integration**: Full control via chat commands
- 📤 **Multi-source Upload**: Support audio/voice messages
- ⏭️ **Queue Management**: Skip/remove tracks, shuffle mode
- 🔄 **Transcoding**: Universal format support via FFmpeg

## Installation 🛠️

### Requirements

- Node.js v20.14+ & Bun runtime
- FFmpeg v6.0+ (`brew install ffmpeg` or `apt-get install ffmpeg` or `winget install ffmpeg`)
- Telegram Bot Token ([create via @BotFather](https://core.telegram.org/bots))

### Quick Start

```bash
git clone https://github.com/pxgo/bun-fm.git
cd bun-fm

# Configure environment (minimum setup)
echo "BUN_FM_BOT_TOKEN=YOUR_TELEGRAM_TOKEN" > .env

npm install && npm run build
npm start
```

Access stream via:  
`ffplay http://127.0.0.1:7080`  
or browser: `http://127.0.0.1:7080`

## Configuration ⚙️

### Environment Variables

| Environment Variables | Description                               | Default                |
| --------------------- | ----------------------------------------- | ---------------------- |
| `BUN_FM_HOST`         | Binding host address                      | `127.0.0.1`            |
| `BUN_FM_PORT`         | HTTP service port                         | `7080`                 |
| `BUN_FM_BOT_TOKEN`    | Telegram Bot Token                        |
| `BUN_FM_TMP_DIR`      | Temporary file storage                    | `./tmp`                |
| `BUN_FM_AUDIO_DIR`    | Persistent audio storage                  | `./media`              |
| `BUN_FM_RANDOM`       | Enable random playback                    | `true`                 |
| `BUN_FM_DOMAIN`       | Public domain                             | `http://[host]:[port]` |
| `BUN_FM_BUFFER_SIZE`  | Audio buffer size                         | `100KB`                |
| `BUN_FM_AUTO_REMOVE`  | Enable automatic deletion of played files | `false`                |

### Telegram Bot Integration

1. Start interacting: `/start`
2. **Upload audio files** directly to chat (supports both audio files and voice messages)
3. Control commands:

| Command       | Description            | Example  |
| ------------- | ---------------------- | -------- |
| `/start`      | Show system status     | `/start` |
| `/ls`         | List available tracks  | `/ls`    |
| `/rm <index>` | Remove track by number | `/rm 3`  |
| `/mute`       | Toggle mute/unmute     | `/mute`  |
| `/next`       | Skip to next track     | `/next`  |

## License 📜

MIT License

# Shove & Survive

**Shove. Dodge. Survive.**

A browser-based multiplayer physics brawler. Create a room, invite 1–7 other players, and shove your way through rounds of power-ups, hazards, and a shrinking arena.

Built with Node.js, Express, Socket.IO, and Canvas 2D.

## Features

- Live multiplayer rooms with six-character codes, invite links, and QR codes
- Server-authoritative movement, collisions, shoves, scoring, and round state
- Keyboard, touchscreen drag, and on-screen joystick controls
- Speed, Shield, Magnet, and Mega Shove power-ups
- Tilt Drift, Slick Sector, and Gust arena hazards
- Round standings, match leaderboard, MVP callouts, and replay/end choices
- Reconnect support for brief connection interruptions
- Responsive layout and reduced-motion support
- `/health` endpoint for hosting platform checks

## How to play

1. Enter a display name and create a room, or enter a friend's room code or open their invite link.
2. Share the room code, invite link, or QR code. Rooms support 2–8 players.
3. Move with **WASD** or the **arrow keys** on desktop. On phones and tablets, drag on the arena or use the on-screen joystick.
4. Press **Space** or tap the action button to dash and shove nearby rivals. The move has a cooldown.
5. Stay on the platform, collect power-ups, and avoid hazards as the arena shrinks. Eliminated players can spectate and toss pebbles.
6. The host sets the match length. At the end of the final round, the host can replay in the same room or end the game.

The entry screen and room panel also include an in-game **How to Play** guide.

## Run locally

Requirements: Node.js 18 or later and npm.

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). To test multiplayer locally, open the address in separate browser sessions or devices on the same network. To let another device on the local network connect, use the development machine's LAN address instead of `localhost`.

## Deploy for worldwide play

The game is ready to run as a public Node.js web service. Deploy it to a host that provides a public HTTPS URL and supports persistent WebSocket connections (for example, a Render Web Service):

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check path:** `/health`
- **Node version:** 18 or newer
- **Port:** The host supplies `PORT`; the server binds to `0.0.0.0`.
- **Public URL (optional):** Set `PUBLIC_URL` to the deployed base URL if QR invitations should use a canonical hostname. Include `https://` and omit a trailing slash.

Share the deployed HTTPS URL with players anywhere in the world. Browsers use Socket.IO's WebSocket transport when available and can fall back to HTTP polling. Latency depends on each player's distance from the hosting region and their network connection; choose a hosting region near the expected players for the best response time.

**Keep the deployment on one server instance.** Room membership, scores, and active matches are stored in process memory, so restarting or scaling to multiple instances clears or splits live rooms. Durable rooms and multi-instance scaling require a shared database and Socket.IO adapter, which this version does not include. Socket.IO accepts browser connections from any origin by default; set `CORS_ORIGIN` to your deployed site origin (for example, `https://game.example.com`) to restrict cross-origin browser access.

Before sharing a new deployment, verify the public URL loads over HTTPS, `/health` returns `{ "ok": true }`, and two separate devices can create/join a room and play a round.

## Project structure

```text
public/
  index.html     Game screens and accessible controls
  client.js      Canvas rendering, input, and Socket.IO client
  styles.css     Responsive and touch-friendly interface
config.js        Server and game tuning values
server.js        Express app, Socket.IO events, and authoritative game loop
package.json     Runtime dependencies and start scripts
README.md        Setup, controls, and deployment guide
```

## Data and privacy

Room state and scores live in server memory and are removed when the process restarts or rooms expire. No account or database is required. Reconnect keys are stored in the browser's local storage for the matching room.

## Development notes

Game constants are in `config.js`. Keep server-side validation authoritative: clients send input intent, while the server owns movement, collisions, cooldowns, power-ups, and scoring. Source files include comments around the main real-time and rendering flows; add comments when changing non-obvious game rules or deployment assumptions.

## License

No license has been specified. Add a license file before granting permissions for reuse or redistribution.

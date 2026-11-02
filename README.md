# Shove & Survive

**Shove. Dodge. Survive.**

A real-time multiplayer physics brawler where players compete to knock each other out of a chaotic arena. Collect power-ups, avoid environmental hazards, and survive each round to climb the leaderboard.

Built with Node.js, Express, Socket.IO, and Canvas 2D.

## Features

- Real-time multiplayer rooms with shareable room codes
- Physics-based movement, collisions, and shoves
- Touch-and-drag movement on phones and tablets
- On-screen joystick support and desktop keyboard controls
- Four power-ups: Speed, Shield, Magnet, and Mega Shove
- Dynamic arena hazards and a shrinking play area
- Round-based matches, scoring, MVP callouts, and leaderboards
- Host controls for match length and match completion
- Reduced-motion setting with operating-system preference support
- Responsive browser-based interface

## Getting Started

### Requirements

- Node.js 18 or later
- npm

### Install

```bash
git clone https://github.com/YOUR_USERNAME/shove-and-survive.git
cd shove-and-survive
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Create a room on one device, then join from another device using the room code.

## Controls

### Desktop
- Move with **WASD** or the **arrow keys**.
- Use **Space** to shove.

### Phones and tablets
- Touch and drag anywhere on the game arena to steer your blob.
- Move your finger farther from the initial touch point for stronger directional input.
- Lift your finger to release movement.
- Use the on-screen action button to shove.

Touch devices use a lower movement speed cap to make steering more manageable.

## Power-ups

| Power-up | Effect |
| --- | --- |
| Speed | Temporarily increases movement speed. |
| Shield | Blocks an incoming shove. |
| Magnet | Pulls nearby players toward you. |
| Mega Shove | Makes your next shove more powerful. |

## Arena Hazards

- **Tilt Drift:** Applies a changing directional drift.
- **Slick Sector:** Reduces friction in part of the arena.
- **Gust:** Adds a sudden movement impulse.

## Deployment

The app can be deployed to Node.js hosting platforms such as [Render](https://render.com/).

For a Render Web Service, use:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check path:** `/health`

The server listens on `0.0.0.0` and uses the `PORT` environment variable supplied by the hosting platform.

## Project Structure

```text
shove-and-survive/
├── public/
│   ├── index.html
│   ├── client.js
│   └── styles.css
├── config.js
├── server.js
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Technology

- Node.js
- Express
- Socket.IO
- HTML, CSS, and JavaScript
- Canvas 2D

## Data and Persistence

Rooms and match scores are stored in server memory and are cleared when the server restarts. The current version does not require a database.

## Contributing

Bug reports, ideas, and pull requests are welcome. For substantial changes, please describe the problem being solved and include steps to test the change.

## License

No license has been specified. Add a license file before granting permissions for reuse or redistribution.

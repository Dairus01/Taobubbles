# TAObubbles

TAObubbles is an interactive Bittensor subnet visualization website.
It displays subnet performance as animated bubbles and includes a sortable data table plus detailed subnet popups.

## Features

- Live subnet data from taostats via same-origin proxy
- Interactive bubble canvas with drag/collision physics
- Period filters: hour, day, week, month
- Bubble size filters: market cap or volume
- Subnet detail popup with stats and links
- Sortable table view
- Light and dark theme toggle

## Project Files

- `index.html` - Main page markup
- `style.css` - Site styles
- `app.js` - Frontend logic and bubble rendering
- `server.py` - Python local server + API proxy
- `server.js` - Node.js local server + API proxy
- `logos/` - Subnet logo images

## Requirements

- Python 3.9+ (recommended runtime)
- Optional: Node.js 18+ (if using `server.js`)

## Quick Start (Python)

1. Open a terminal in the project folder.
2. Start the server:

```bash
python3 server.py
```

3. Open:

```text
http://127.0.0.1:8080
```

## Quick Start (Node.js)

If Node.js is installed:

```bash
node server.js
```

Then open `http://127.0.0.1:8080`.

## Troubleshooting

### Connection Refused on 127.0.0.1:8080

- The server is not running.
- Start it with `python3 server.py`.

### Address Already in Use

Another process is already using port 8080.

Find the process:

```bash
ss -ltnp '( sport = :8080 )'
```

Then stop it, or run the server on a different port:

```bash
PORT=8081 python3 server.py
```

Open `http://127.0.0.1:8081`.

## API Endpoint

The frontend expects:

- `GET /api/subnets`

This endpoint is proxied by `server.py` or `server.js` to taostats.

## Notes

- Some subnet logo files may be missing; this can produce harmless 404s for specific logo paths.
- Use `server.py` or `server.js` (not plain static hosting) so `/api/subnets` works correctly.

# Indian History Bite

Daily Indian history story generator powered by Claude API (Haiku).

## Tech Stack
- Node.js + Express on port 3001
- Vanilla JS frontend served from app/src/public/
- Claude API via axios (model: claude-haiku-4-5-20251001)
- Production env loaded from /etc/indianhistorybite/.env

## Key Endpoints
- `GET /indianhistorybite/api/result` — public, returns cached daily story
- `POST /indianhistorybite/api/refresh` — protected by x-api-key header, generates new story

## Key Files
- `app/src/server.js` — Express server, Claude API call, story generation
- `app/src/security.js` — rate limiting, helmet, API key auth, input validation
- `app/src/public/` — frontend assets (app.js, app.css, index.html)
- `runtime/data/current-story.json` — persisted daily story
- `runtime/logs/` — API call logs (contains prompts+responses, never read these)

## Security
- API key required via x-api-key header only (no query string)
- Rate limits: 100 req/15min general, 10 req/hr refresh
- Prompt instructions in system message, user-controlled data in user message
- storyDateKey validated with strict YYYY-MM-DD regex
- Strict CSP, HSTS, helmet headers

## Rules
- Never read .env files, runtime/logs/, or API keys
- No test framework exists — be careful with changes, test manually
- Do not push to main without explicit user approval via /deploy

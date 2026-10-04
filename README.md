# sidekik-meetbot

The Recall.ai connector for Sidekik (`bot.sidekik.live`, port 8086). It sends a bot into Google Meet, Zoom or Teams that runs the agent-host page as its camera, forwards the shared screen to perception, and publishes speech and bot lifecycle events. Spec: `docs/DESIGN.md`.

## Run

```bash
pnpm install
cp .env.example .env     # fill in from the team vault
pnpm dev                 # needs Redis: docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d
pnpm dev:mock            # no Recall, Supabase or teammates' services; Recall is a logging stand-in
pnpm typecheck && pnpm test
```

`GET /healthz` returns `{ok, version, deps}` (Redis, Supabase).

## Recall

`src/recall/client.ts` wraps the Recall REST API (`https://{RECALL_REGION}.recall.ai/api/v1`, `Authorization: Token …`). The Create Bot body was checked against docs.recall.ai on 2026-10-04 and differs from DESIGN §3 in a few places:

- the real-time WebSocket URL needs a `/` before the query: `wss://bot.sidekik.live/recall/ws/{sid}/?secret=…` (Recall answers 400 otherwise);
- per-participant H.264 needs `recording_config.video_mixed_layout: "gallery_view_v2"` and the `web_4_core` bot variant (billed at $0.60 per hour);
- `metadata: {session_id}` comes back on every status webhook and real-time event;
- `recording_config.retention: null` keeps media in memory only, so there are no recordings to delete after a test;
- there is no screen-share-only stream: screen share arrives as `video_separate_h264.data` with `type: "screenshare"`.

# sidekik-meetbot: DESIGN

**Owner:** Aadil · **Reviewer:** Sahil · **Public host:** `bot.sidekik.live` · **Local port:** 8086
**Priority:** after Checkpoint 2. Demo **Google Meet** first. **Cut it if it isn't working by H21**; the browser rooms already meet the brief.

## 1. Purpose

Meetbot lets Sidekik join Google Meet, Zoom or Teams as a participant through **Recall.ai**, so the expert never leaves their meeting. It covers three things:

| Need | How |
|---|---|
| **See** the shared screen | Recall real-time video (H.264). Meetbot decodes it to 1 fps JPEG and forwards it to perception. |
| **Hear and speak** | Recall **Output Media** runs `https://app.sidekik.live/agent-host/{sid}?t=…` as the bot's camera. That page holds the ElevenAgents session: meeting audio goes in, and the page's audio comes out into the meeting. |
| **Know when people talk** | Recall `participant_events.speech_on/off` → `sk:speech.signals` (feeds brain's pause detector) |

## 2. Interfaces

**Inbound**

| Endpoint | Detail |
|---|---|
| `POST /internal/bots` | `{session_id, meeting_url, bot_name:"Sidekik (recording)"}` → `{bot_id}`. Called by gateway. |
| `DELETE /internal/bots/:sid` | Remove the bot from the call. |
| `POST /recall/webhook` (public) | Bot status changes, secret-verified. |
| `WS /recall/ws/:sid?secret=` (public) | Recall real-time events. |

**Outbound**

| Destination | Detail |
|---|---|
| `WS perception /internal/frames/:sid` | 1 fps JPEG with header `{t_ms, reason:"tick"}` |
| `sk:speech.signals` | `{kind:"user_speech_start"\|"user_speech_end", source:"recall"}`, ignoring the bot's own participant ID |
| `sk:session.lifecycle` | `bot_joined`, `bot_left`, `bot_error` (with reason) |
| `sk:usage` | Recall hours × $0.50 |
| Table | `meeting_bots` (bot_id, session_id, platform, status, joined_at, left_at, error) |

## 3. Bot creation (map to the current Recall API before coding)

```jsonc
POST https://{RECALL_REGION}.recall.ai/api/v1/bot/
{
  "meeting_url": "<meet/zoom/teams url>",
  "bot_name": "Sidekik (recording)",
  "output_media": { "camera": { "kind": "webpage",
      "config": { "url": "https://app.sidekik.live/agent-host/{sid}?t={one_time_token}" } } },
  "recording_config": {
    "video_separate_h264": {},                 // or the screenshare-specific stream if offered; NOT the 360p PNG
    "realtime_endpoints": [{ "type": "websocket",
      "url": "wss://bot.sidekik.live/recall/ws/{sid}?secret={RECALL_WS_SECRET}",
      "events": ["video_separate_h264.data", "participant_events.speech_on",
                 "participant_events.speech_off", "participant_events.screenshare_on",
                 "participant_events.screenshare_off"] }]
  },
  "chat": { "on_bot_join": { "send_to": "everyone",
      "message": "Sidekik is recording this session with consent. Say 'off the record' or type /off to pause." } }
}
```

Get the `one_time_token` from gateway `POST /internal/agent-host-token {sid}`.

## 4. Video handling

- **Pick the stream:** after `screenshare_on`, choose the video stream for the screen-share participant; before it, ignore video.
- **Decode:** pipe the H.264 into a long-lived `ffmpeg -f h264 -i pipe:0 -vf fps=1,scale=1280:-1 -f image2pipe -vcodec mjpeg pipe:1` process per session. Forward each JPEG to perception.
- **Off-record:** on `offrecord_on`, stop forwarding frames but keep the decoder running so resuming is instant.
- **Chat:** a meeting chat message `/off` or `/on` triggers gateway `POST /internal/sessions/:id/off-record`, if Recall chat events are available.

## 5. Risks to test in the H18 spike

- **Latency:** measure the round trip from the expert stopping speaking to the agent's voice in the meeting. Budget an extra 300–800 ms compared with browser mode.
- **Echo:** the agent hearing itself. The agent-host page mutes its input while the agent speaks; confirm this works.
- **Admission:** Google Meet requires the host to admit the bot. Zoom external meetings need an OBF token; Teams may hit lobby policies.
- **Pricing:** Recall's free hours run out quickly during testing. Delete recordings after each test.

## 6. Env

`PORT, REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SK_INTERNAL_TOKEN, RECALL_API_KEY, RECALL_REGION, RECALL_WS_SECRET, RECALL_WEBHOOK_SECRET, PERCEPTION_INTERNAL_URL, GATEWAY_INTERNAL_URL, APP_URL=https://app.sidekik.live`

The Docker image needs `ffmpeg`.

## 7. Claude Code tickets

1. Scaffold, env, Recall client wrapper.
2. `POST/DELETE /internal/bots` and the `meeting_bots` table.
3. Webhook, mapped to lifecycle events.
4. Real-time WebSocket: event router, speech signals, screen-share tracking.
5. H.264 → JPEG decoder per session, forwarding to perception, with backpressure (drop frames, never queue them).
6. Off-record handling and the `/off` chat command.
7. `scripts/join.ts <meet-url>` for manual testing.

## 8. Definition of done

- A Meet call with a shared MiniERP shows the bot joining as "Sidekik (recording)" with its status tile.
- Perception receives screen frames.
- The interviewer asks its question in the meeting, using the same brain and gateway flow as browser mode.

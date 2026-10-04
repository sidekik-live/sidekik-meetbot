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
| `POST /recall/webhook` (public) | Bot status changes (`bot.*`, delivered by Svix), signed with Recall's workspace verification secret (`webhook-*` / `svix-*` headers). |
| `WS /recall/ws/:sid/?secret=` (public) | Recall real-time events. Recall requires the `/` before the query. |

**Outbound**

| Destination | Detail |
|---|---|
| `WS perception /internal/frames/:sid` | 1 fps JPEG with header `{t_ms, reason:"tick"}`: header length as a big-endian uint32, the JSON header, then the JPEG bytes. `X-Internal-Token` on the upgrade. |
| `sk:speech.signals` | `{kind:"user_speech_start"\|"user_speech_end", source:"recall"}`, ignoring the bot's own participant ID |
| `sk:session.lifecycle` | `bot_joined` (status `in_call_recording`), `bot_left` (`call_ended`, `done`, `fatal`), `bot_error` (`fatal`, `recording_permission_denied`); `reason` is Recall's sub code |
| `sk:usage` | Recall hours from `in_call_recording` to leaving, priced as `recall/bot_web_4_core` ($0.60/h: per-participant video needs the `web_4_core` variant) |
| Table | `meeting_bots` (bot_id, session_id, platform, status, joined_at, left_at, error) |

## 3. Bot creation (checked against docs.recall.ai on 2026-10-04)

```jsonc
POST https://{RECALL_REGION}.recall.ai/api/v1/bot/        // Authorization: Token {RECALL_API_KEY}
{
  "meeting_url": "<meet/zoom/teams url>",
  "bot_name": "Sidekik (recording)",
  "metadata": { "session_id": "{sid}" },                  // comes back on every webhook and real-time event
  "variant": { "zoom": "web_4_core", "google_meet": "web_4_core", "microsoft_teams": "web_4_core" },
  "output_media": { "camera": { "kind": "webpage",
      "config": { "url": "https://app.sidekik.live/agent-host/{sid}?t={one_time_token}" } } },
  "recording_config": {
    "video_mixed_layout": "gallery_view_v2",              // needed for per-participant video
    "video_separate_h264": {},                            // no screenshare-only stream: frames carry type "screenshare" | "webcam"
    "retention": null,                                    // media stays in memory: nothing to delete after a test
    "realtime_endpoints": [{ "type": "websocket",
      "url": "wss://bot.sidekik.live/recall/ws/{sid}/?secret={RECALL_WS_SECRET}",
      "events": ["video_separate_h264.data", "participant_events.speech_on",
                 "participant_events.speech_off", "participant_events.screenshare_on",
                 "participant_events.screenshare_off", "participant_events.chat_message"] }]
  },
  "chat": { "on_bot_join": { "send_to": "everyone",
      "message": "Sidekik is recording this session with consent. Say 'off the record' or type /off to pause." } }
}
```

- Get the `one_time_token` from gateway `POST /internal/agent-host-token {sid}`.
- One live bot per session: a retried `POST /internal/bots` gets the existing `bot_id` back.
- Removing a bot: `POST /api/v1/bot/{id}/leave_call/`.
- Status webhooks must be subscribed in the Recall dashboard (they can't go through `realtime_endpoints`). Real-time events start once the bot is `in_call_recording`.
- Recall has no "this is the bot" flag on participants; meetbot skips the participant named like the bot.

## 4. Video handling

- **Pick the stream:** after `screenshare_on`, choose the video stream for the screen-share participant; before it, ignore video.
- **Decode:** pipe the H.264 (Annex-B, one access unit per message) into a long-lived ffmpeg per session: `-use_wallclock_as_timestamps 1 -f h264 -i pipe:0 -vf fps=1,scale='min(1280,iw)':-2 -f image2pipe -c:v mjpeg pipe:1` (raw H.264 has no timestamps, so packets get the wall clock). With a small probe and one decoder thread the first JPEG comes ~2.5 s after the share starts, then one per second. Forward each JPEG to perception.
- **Backpressure:** never queue. Drop access units until a keyframe (SPS/IDR) and whenever ffmpeg is behind (then wait for the next keyframe); drop JPEGs while the perception socket is down or busy. Perception closing with `4410` ends the link.
- **Off-record:** on `offrecord_on`, stop forwarding frames but keep the decoder running so resuming is instant.
- **Chat:** a meeting chat message starting with `/off` or `/on` triggers gateway `POST /internal/sessions/:id/off-record {on, source: "chat"}` (Recall `participant_events.chat_message`).

## 5. Risks to test in the H18 spike

- **Latency:** measure the round trip from the expert stopping speaking to the agent's voice in the meeting. Budget an extra 300–800 ms compared with browser mode.
- **Echo:** the agent hearing itself. The agent-host page mutes its input while the agent speaks; confirm this works.
- **Admission:** Google Meet requires the host to admit the bot. Zoom external meetings need an OBF token; Teams may hit lobby policies.
- **Pricing:** Recall's free hours run out quickly during testing. Delete recordings after each test.

## 6. Env

`PORT, LOG_LEVEL, REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SK_INTERNAL_TOKEN, RECALL_API_KEY, RECALL_REGION, RECALL_WS_SECRET, RECALL_WEBHOOK_SECRET` (workspace verification secret, `whsec_…`), `PERCEPTION_INTERNAL_URL, GATEWAY_INTERNAL_URL, APP_URL=https://app.sidekik.live, PUBLIC_URL=https://bot.sidekik.live, FFMPEG_PATH` (optional)

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

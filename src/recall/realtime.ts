import { z } from 'zod';

/** docs.recall.ai: real-time event payloads. Fields we don't use are left out (zod strips them). */
const ParticipantSchema = z.object({
  id: z.number().int(),
  name: z.string().nullish(),
  is_host: z.boolean().nullish(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

const TimestampSchema = z.object({
  /** ISO 8601 wall clock. */
  absolute: z.string().min(1),
  /** Seconds since the bot started recording. */
  relative: z.number(),
});

const ParticipantEventSchema = z.object({
  participant: ParticipantSchema,
  timestamp: TimestampSchema,
});

export const RealtimeMessageSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('video_separate_h264.data'),
    data: z.object({
      data: z.object({
        /** Base64 H.264 (Annex-B), one access unit per message. */
        buffer: z.string(),
        timestamp: TimestampSchema,
        type: z.enum(['webcam', 'screenshare']),
        participant: ParticipantSchema,
      }),
    }),
  }),
  ...(
    [
      'participant_events.speech_on',
      'participant_events.speech_off',
      'participant_events.screenshare_on',
      'participant_events.screenshare_off',
    ] as const
  ).map((event) => z.object({ event: z.literal(event), data: z.object({ data: ParticipantEventSchema }) })),
  z.object({
    event: z.literal('participant_events.chat_message'),
    data: z.object({
      data: ParticipantEventSchema.extend({
        data: z.object({ text: z.string(), to: z.string().nullish() }).nullish(),
      }),
    }),
  }),
] as [z.ZodObject, ...z.ZodObject[]]);

export type VideoMessage = {
  event: 'video_separate_h264.data';
  data: { data: { buffer: string; timestamp: { absolute: string; relative: number }; type: 'webcam' | 'screenshare'; participant: Participant } };
};
export type ParticipantMessage = {
  event:
    | 'participant_events.speech_on'
    | 'participant_events.speech_off'
    | 'participant_events.screenshare_on'
    | 'participant_events.screenshare_off';
  data: { data: { participant: Participant; timestamp: { absolute: string; relative: number } } };
};
export type ChatMessage = {
  event: 'participant_events.chat_message';
  data: {
    data: {
      participant: Participant;
      timestamp: { absolute: string; relative: number };
      data?: { text: string; to?: string | null } | null;
    };
  };
};
export type RealtimeMessage = VideoMessage | ParticipantMessage | ChatMessage;

/** Parses one text message from Recall; null for anything we don't subscribe to or can't read. */
export function parseRealtimeMessage(text: string): RealtimeMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RealtimeMessageSchema.safeParse(json);
  return parsed.success ? (parsed.data as RealtimeMessage) : null;
}

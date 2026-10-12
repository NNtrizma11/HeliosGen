// ─────────────────────────────────────────────────────────────────────────────
// VOICE CONFIG — text-to-speech models and voices for the Voice node.
//
// Source: https://docs.kie.ai/market/elevenlabs/text-to-speech-multilingual-v2
// Multilingual v2 detects the language from the text itself, so a Bulgarian or
// Romanian script is spoken in that language by any voice below.
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceModel {
  id: string;
  apiId: string;
  name: string;
  /** Max characters of text per request */
  maxChars: number;
}

export const VOICE_MODELS: VoiceModel[] = [
  {
    id: "elevenlabs-multilingual-v2",
    apiId: "elevenlabs/text-to-speech-multilingual-v2",
    name: "ElevenLabs Multilingual v2",
    maxChars: 5000,
  },
];

export const DEFAULT_VOICE_MODEL = VOICE_MODELS[0].id;

export interface Voice {
  id: string;
  name: string;
}

/** Voice IDs accepted by Kie's ElevenLabs endpoints (exact values from the docs). */
export const VOICES: Voice[] = [
  { id: "EkK5I93UQWFDigLMpZcX", name: "James" },
  { id: "Z3R5wn05IrDiVCyEkUrK", name: "Arabella" },
  { id: "NNl6r8mD7vthiJatiJt1", name: "Bradford" },
  { id: "YOq2y2Up4RgXP2HyXjE5", name: "Xavier" },
  { id: "B8gJV1IhpuegLxdpXFOE", name: "Kuon" },
  { id: "2zRM7PkgwBPiau2jvVXc", name: "Monika Sogam" },
  { id: "1SM7GgM6IMuvQlz2BwM3", name: "Mark" },
  { id: "5l5f8iK3YPeGga21rQIX", name: "Adeline" },
  { id: "scOwDtmlUjD3prqpp97I", name: "Sam" },
  { id: "NOpBlnGInO9m6vDvFkFC", name: "Spuds Oxley" },
  { id: "BZgkqPqms7Kj9ulSkVzn", name: "Eve" },
  { id: "wo6udizrrtpIxWGp2qJk", name: "Northern Terry" },
  { id: "gU0LNdkMOQCOrPrwtbee", name: "British Football Announcer" },
  { id: "DGzg6RaUqxGRTHSBjfgF", name: "Brock" },
  { id: "x70vRnQBMBu4FAYhjJbO", name: "Nathan" },
  { id: "Sm1seazb4gs7RSlUVw7c", name: "Anika" },
  { id: "P1bg08DkjqiVEzOn76yG", name: "Viraj" },
  { id: "qDuRKMlYmrm8trt5QyBn", name: "Taksh" },
  { id: "qXpMhyvQqiRxWQs4qSSB", name: "Horatius" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura" },
  { id: "kPzsL2i3teMYv0FxEYQ6", name: "Brittney" },
  { id: "UgBBYS2sOqTuMpoF3BR0", name: "Mark (2)" },
  { id: "hpp4J3VqNfWAUOO0d1Us", name: "Bella" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },
  { id: "uYXf8XasLslADfZ2MB4u", name: "Hope" },
  { id: "gs0tAILXbY5DNrJrsM6F", name: "Jeff" },
  { id: "DTKMou8ccj1ZaWGBiotd", name: "Jamahal" },
  { id: "vBKc2FfBKJfcZNyEt1n6", name: "Finn" },
  { id: "DYkrAHD8iwork3YSUBbs", name: "Tom" },
  { id: "56AoDkrOh6qfVPDXZ7Pt", name: "Cassidy" },
  { id: "eR40ATw9ArzDf9h3v7t7", name: "Addison 2.0" },
  { id: "g6xIsTj2HwM6VR4iXFCw", name: "Jessica Anne Bogart" },
  { id: "lcMyyd2HUfFzxdCaC4Ta", name: "Lucy" },
  { id: "6aDn1KB0hjpdcocrUkmq", name: "Tiffany" },
  { id: "Sq93GQT4X1lKDXsQcixO", name: "Felix" },
  { id: "flHkNRp1BlvT73UL6gyz", name: "Jessica Anne Bogart (Villain)" },
  { id: "9yzdeviXkFddZ4Oz8Mok", name: "Lutz" },
  { id: "pPdl9cQBQq4p6mRkZy2Z", name: "Emma" },
  { id: "zYcjlYFOd3taleS0gkk3", name: "Edward" },
  { id: "nzeAacJi50IvxcyDnMXa", name: "Marshal" },
  { id: "ruirxsoakN0GWmGNIo04", name: "John Morgan" },
  { id: "TC0Zp7WVFzhA8zpTlRqV", name: "Aria" },
  { id: "ljo9gAlSqKOvF6D8sOsX", name: "Viking Bjorn" },
  { id: "PPzYpIqttlTYA83688JI", name: "Pirate Marshal" },
  { id: "8JVbfL6oEdmuxKn5DK2C", name: "Johnny Kid" },
  { id: "iCrDUkL56s3C8sCRl7wb", name: "Hope (Poetic)" },
  { id: "wJqPPQ618aTW29mptyoc", name: "Ana Rita" },
  { id: "EiNlNiXeDU1pqqOPrYMO", name: "John Doe" },
  { id: "4YYIPFl9wE5c4L2eu2Gb", name: "Burt Reynolds" },
  { id: "6F5Zhi321D3Oq7v1oNT4", name: "Hank" },
  { id: "YXpFCvM1S3JbWEJhoskW", name: "Wyatt" },
  { id: "LG95yZDEHg6fCZdQjLqj", name: "Phil" },
  { id: "CeNX9CMwmxDxUF5Q2Inm", name: "Johnny Dynamite" },
  { id: "aD6riP1btT197c6dACmy", name: "Rachel M" },
  { id: "mtrellq69YZsNwzUSyXh", name: "Rex Thunder" },
  { id: "dHd5gvgSOzSfduK4CvEg", name: "Ed" },
  { id: "eVItLK1UvXctxuaRV2Oq", name: "Jean" },
  { id: "esy0r39YPLQjOczyOib8", name: "Britney" },
  { id: "Tsns2HvNFKfGiNjllgqo", name: "Sven" },
  { id: "1U02n4nD6AdIZ9CjF053", name: "Viraj (Smooth)" },
  { id: "AeRdCCKzvd23BpJoofzx", name: "Nathaniel" },
  { id: "LruHrtVF6PSyGItzMNHS", name: "Benjamin" },
  { id: "1wGbFxmAM3Fgw63G1zZJ", name: "Allison" },
  { id: "hqfrgApggtO1785R4Fsn", name: "Theodore HQ" },
  { id: "MJ0RnG71ty4LH3dvNfSd", name: "Leon" },
];

export const DEFAULT_VOICE = VOICES[0].id;

/** Short preview clip Kie hosts for every voice. */
export function voicePreviewUrl(voiceId: string): string {
  return `https://static.aiquickdraw.com/elevenlabs/voice/${voiceId}.mp3`;
}

/** Slider settings exposed on the node, with the API's ranges and defaults. */
export const VOICE_SETTINGS = {
  speed:            { min: 0.7, max: 1.2, step: 0.01, default: 1 },
  stability:        { min: 0,   max: 1,   step: 0.01, default: 0.5 },
  similarity_boost: { min: 0,   max: 1,   step: 0.01, default: 0.75 },
  style:            { min: 0,   max: 1,   step: 0.01, default: 0 },
} as const;

export type VoiceSettingKey = keyof typeof VOICE_SETTINGS;

export function clampSetting(key: VoiceSettingKey, value: unknown): number {
  const s = VOICE_SETTINGS[key];
  const n = typeof value === "number" && Number.isFinite(value) ? value : s.default;
  return Math.min(s.max, Math.max(s.min, n));
}

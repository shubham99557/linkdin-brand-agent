/**
 * LinkedIn "little text format": these characters are reserved in `commentary` and must be
 * backslash-escaped, otherwise text can be dropped or misread as markup.
 * Source: learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 *
 * Phase 2.1 escapes everything, so hashtags render as plain text. Hashtag/mention markup
 * (`{hashtag|\#|tag}`) is deferred until verified in the Stage 2.2 pilot.
 */
const RESERVED = /[|{}@[\]()<>#\\*_~]/g;

export function escapeLittleText(text: string): string {
  return text.replace(RESERVED, (c) => `\\${c}`);
}

export const LINKEDIN_COMMENTARY_MAX = 3000; // documented for the legacy UGC API; assumed for Posts API (UNCONFIRMED)

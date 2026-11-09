# Google voice selection, 13 October 2026

The generated-draft panel now separates **voice identity** from **delivery style**.
The 30 documented studio voices remain selectable. An explicit Load Google voices
button browses Google's extended prebuilt catalog with search, language, gender
and pagination. Each returned choice shows its name, language, pitch, gender and
Google description. The saved choice remains visible while changing filters.

The server caches only validated prebuilt ids from Google, bound to the current
credential fingerprint. Custom/replicated voices and unverified arbitrary ids are
not accepted. The catalog is used consistently by draft edits, preview and apply.
Reopening reads the local cache, not Google. A failed refresh preserves choices;
changing the key requires reloading extended catalog eligibility.

The style presets (Natural, Friendly, Narration, Podcast, Promote, Whisper, Custom)
are application shortcuts for Google speech-metadata instructions, not voice ids
or a promise that Google exposes a preset enum. Style never becomes spoken text.
Changing or saving a choice generates no audio. Preview remains an explicit action
with the existing budget; no new preview was generated for this feature.

Live read-only evidence: `/api/factory/ai/voices/refresh` with search `Cruz`
returned HTTP 200, voice id `en-us-cruz`, name `Cruz`, language `en-US`, male,
low pitch and the official catalog description. This proves metadata retrieval,
not synthesis quality for that voice. The first unfiltered catalog read returned
1,000 entries with another page available, so the UI does not pretend that the
studio list is the whole library.

Tests cover extended-id validation, custom/malformed-id refusal, key changes,
429 preserving the cache, and invalid filters before network access. DOM checks
use the real application routes and a labelled Google catalog double: select an
extended voice and Podcast style, save, reopen, preserve choices, and verify that
no extra text or speech generation happens. These are not browser evidence.

Reference: https://ai.google.dev/gemini-api/docs/speech-generation#voice-options

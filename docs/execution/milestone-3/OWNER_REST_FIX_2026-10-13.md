# Owner-host REST fix, 13 October 2026

Base: `48d44cdf1bb01d7a4cdd4a3363b3c658a7b7226d`.

The live check exposed two different issues. Google returned HTTP 404 for
`gemini-2.5-flash` and explicitly said that model is no longer available to new
users, recommending `gemini-3.8-flash` and Interactions. The original speech
request returned HTTP 400. A catalog entry was not proof that generation worked.

## Changes

- Default planning model is now `gemini-3.8-flash`. Its structured plan uses
  `/v1beta/interactions`, `response_format` with a JSON schema, and step-based
  response parsing. Existing plan validation remains mandatory before adoption.
- Both `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` use the documented
  Interactions speech request. Text remains verbatim; style is in speech metadata.
  WAV output is validated through the existing parser. Incomplete interactions
  and multiple audio blocks are refused rather than silently dropped.
- `store:false` is sent. Secrets stay in the header; timeout/cancel cover the
  complete response. No additional dependency, SDK, model download or fallback.
- Older explicitly configured 2.5 text clients retain their GenerateContent
  contract; they are not automatically selected or retried.
- HTTP 400 and 404 now explain configuration/model compatibility instead of
  suggesting an unchanged retry. Quota handling remains separate.

## Actual evidence

- Core build and API typecheck passed.
- Seven affected test files: 102 passed. Includes the new REST contract tests,
  provider deadline/cancellation, API flow, durable turn cache and DOM flow.
  These tests use labelled doubles and do not prove Google quality.
- **Live Arabic speech succeeded**, through the actual app speech-preview route:
  model `gemini-3.8-flash-lite-tts`, voice `Kore`, job
  `7699b946-a9aa-42f2-8227-af27b217bf7b`, WAV 24 kHz mono,
  4.6 seconds, 226,914 bytes, SHA-256
  `91033274e81d44324978d6aa958c7b78aa9a2c4d2875824a13ae516307b55722`.
  Input was the already reviewed Arabic sentence. Approval remains false.
- No recording or saved timing was replaced. No render, push or F deployment.
- Owner QA ledger totals: **text 2, voice 2, production 0**. The failed attempts
  count. The ledger was neither deleted nor reset.

## Still pending

After the initial diagnostic allowance was exhausted, the owner explicitly
authorized **one additional text request**. The same QA root retained the original
ledger, and a separately recorded authorization limited this check to text 1,
voice 0 and production 0. The request to 3.8 Interactions returned HTTP **503**:
Google reported high demand for `gemini-3.8-flash`. There was no automatic retry
and no draft was adopted. Job: `ea03ce41-41e4-4a9b-ad81-f3b706e8e061`.

The new planning contract is fixture-tested and a real request was attempted;
successful live planning remains unproven. Total authorized calls across both
ledgers: text 3, voice 2, production 0. Do not reset or delete either ledger.

English quality, Flash TTS live acceptance, listening review and browser acceptance
are not proven by the Arabic WAV. This fix is not final factory acceptance.

## Selecting the speech model

The existing server configuration supports either model, without changing the key:

```powershell
$env:GEMINI_TTS_MODEL = 'gemini-3.8-flash-lite-tts'
# Or explicitly choose:
$env:GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts'
```

Restart the server to apply its environment. There is no automatic switch on 400,
404 or 429, no paid fallback, and no budget reset. This is server configuration;
an in-page model selector was not added. Verification remains bound to the actual
key and model, and changing models does not inherit a different model's acceptance.

References: [Google speech generation](https://ai.google.dev/gemini-api/docs/speech-generation),
[structured output](https://ai.google.dev/gemini-api/docs/structured-output).

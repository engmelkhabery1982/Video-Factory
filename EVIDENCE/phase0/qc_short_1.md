# QC report — Video_01 (short_1)
**Verdict:** WARN  
**Generated:** 2026-09-29T12:18:06.614Z  
## Metrics
| key | value |
| --- | --- |
| sceneCount | 13 |
| plannedDurationSec | 33.61 |
| captionCues | 16 |
| audioFile | Video_01_short_1.mp3 |
| audioDurationSec | 33.31 |
| targetDurationSec | 33.61 |
| width | 1080 |
| height | 1920 |
| fps | 30/1 |
| videoCodec | h264 |
| pixFmt | yuv420p |
| videoBitrateKbps | 8048 |
| audioCodec | aac |
| audioBitrateKbps | 223 |
| audioSampleRate | 48000 |
| durationSec | 33.6 |
| sizeMB | 34.77 |
| blackSeconds | 0 |
| longestSilenceSec | 0 |
| aspectRatio | 0.563 |
| expectedAspectRatio | 0.563 |
## Technical QC
| severity | category | check | detail | where |
| --- | --- | --- | --- | --- |
| PASS | technical | Resolution | 1080x1920 (expected 1080x1920). |  |
| PASS | technical | Frame rate | 30.00 fps (expected 30). |  |
| PASS | technical | Aspect ratio | 0.563 (expected 0.563). |  |
| PASS | technical | Video codec | h264 (expected h264). |  |
| PASS | technical | Pixel format | yuv420p (expected yuv420p - required for browser playback). |  |
| PASS | technical | Video bitrate | 8048 kbps (target 6-14 Mbps). |  |
| PASS | technical | Audio codec | aac (expected aac). |  |
| PASS | technical | Audio bitrate | 223 kbps (expected 192-256 kbps). |  |
| PASS | technical | Audio sample rate | 48000 Hz (expected 48000). |  |
| PASS | technical | Duration | 33.60s (Short must be 20-35s). |  |
| PASS | technical | Missing media | 0 referenced media file(s) could not be resolved. |  |
| PASS | technical | Black or empty frames | 0 black frame(s) detected, 0.00s total. |  |
| PASS | technical | Audio silence | Longest silence 0.00s (threshold 1.5s). |  |
## Visual QC
| severity | category | check | detail | where |
| --- | --- | --- | --- | --- |
| WARN | visual | Short held on one idea too long | short_1 scene 8 runs 3.3s; change the visual every 1.5-3s. |  |
| WARN | visual | Short held on one idea too long | short_1 scene 10 runs 4.6s; change the visual every 1.5-3s. |  |
| WARN | visual | Short held on one idea too long | short_1 scene 12 runs 3.4s; change the visual every 1.5-3s. |  |
| WARN | visual | Short held on one idea too long | short_2 scene 2 runs 4.4s; change the visual every 1.5-3s. |  |
| WARN | visual | Short held on one idea too long | short_2 scene 9 runs 3.2s; change the visual every 1.5-3s. |  |
| WARN | visual | Short held on one idea too long | short_3 scene 10 runs 4.4s; change the visual every 1.5-3s. |  |
| PASS | visual | Caption reading speed | 0 cue(s) exceed 21 characters per second. |  |
## Content QC
| severity | category | check | detail | where |
| --- | --- | --- | --- | --- |
| WARN | content | Short hook too slow | short_1 hook lasts 4.6s; the full hook must be readable in the first 2 seconds. |  |
| WARN | content | Short hook too slow | short_2 hook lasts 4.4s; the full hook must be readable in the first 2 seconds. |  |
| WARN | content | Short hook too slow | short_3 hook lasts 5.1s; the full hook must be readable in the first 2 seconds. |  |
| PASS | content | Key numbers | All 4 key number(s) from the script appear on screen. |  |
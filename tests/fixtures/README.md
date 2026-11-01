# Public-network verification fixtures

Authored synthetic material, under this repository's MIT license; no learner content, real speech or AI output.

- `url-public.txt`: short original text with an explicit final marker.
- `url-public.wav`: one second of a quiet 440-Hz, 16-kHz mono PCM tone.
- `url-public.mp4`: 1.25 seconds of white 160×90 video at 8 FPS with an 880-Hz tone, H.264/AAC. Generated with the cached pinned FFmpeg build; 12,342 bytes in the original fixture.

The opt-in `tests/url-public-smoke.mjs` fetches these files from the exact GitHub commit over guarded public HTTPS, verifies SHA-256 against the checkout, and exercises normal local preparation. It also fetches example.com for real static HTML. These are not demonstrations of recognition, pronunciation or real teaching quality.

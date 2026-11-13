# `pnpm test` races the emulator

`tests/test.sh` sleeps a fixed 10s after `docker run`; on a cold start the emulator is not ready yet, so the first test in every file times out at 5s (seen 2026-11-12: 10 failures, all green against a ready emulator). Poll `localhost:8080` until it answers instead of sleeping.

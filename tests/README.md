# Browser tests

Playwright checks that drive the reader in Chromium. Start the app first:

```bash
export PATH="$HOME/.dotnet:$PATH"
cd PdfReaderApp && dotnet run --no-launch-profile --urls http://0.0.0.0:12000
```

Then:

```bash
python3 tests/test_narration_server.py     # needs TtsServer running on port 12001
python3 tests/test_narration_fallback.py   # needs TtsServer stopped
```

Each script prints a PASS/FAIL line per check and exits non-zero if any fail.

- `test_narration_server.py` — the narrator engine is detected and offered, both
  WAV and MP3 export work with it, the offline engine still works, and the two
  engines produce different audio (so the server is genuinely in the path).
- `test_narration_fallback.py` — with the server stopped the narrator option is
  disabled, export falls back to the offline engine, and no JavaScript error is
  raised. The only console entry is the browser's own `ERR_CONNECTION_REFUSED`
  for the probe.

The two are separate because the fallback case needs the server down. Both read
the sample PDFs from `PdfReaderApp/wwwroot/samples/`.

"""Narration server export test.

Confirms the reader can export audio with the server's neural voice, that the audio is
real, and that the offline engine still works when the server is not used.

Checks:
  1. The engine dropdown offers the narrator voice, meaning the server was detected.
  2. Server engine -> WAV: file is a non-silent RIFF/WAVE at 22.05 kHz.
  3. Server engine -> MP3: the browser-side encoder still produces a usable file.
  4. Offline engine still exports, so the fallback path is intact.
  5. The two engines produce different audio, proving the server is really in the path.
  6. No console errors.
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:12000/"
SAMPLES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "PdfReaderApp", "wwwroot", "samples") + os.sep

DECODE_AUDIO = """async () => {
    const el = document.querySelector('audio');
    if (!el || !el.src) { return null; }
    const response = await fetch(el.src);
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);

    // WAV has a RIFF header; MP3 starts with an ID3 tag or a frame sync.
    const riff = buffer.byteLength > 12 && String.fromCharCode(
        view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) === 'RIFF';
    const wave = buffer.byteLength > 12 && String.fromCharCode(
        view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)) === 'WAVE';

    let nonZero = 0;
    let sampleRate = 0;
    let peak = 0;
    if (riff && wave) {
        sampleRate = view.getUint32(24, true);
        for (let i = 44; i + 1 < buffer.byteLength; i += 2) {
            const sample = view.getInt16(i, true);
            if (sample !== 0) { nonZero++; }
            peak = Math.max(peak, Math.abs(sample));
        }
    } else {
        // For MP3 just prove the payload is not a run of identical bytes.
        const seen = new Set();
        for (let i = 0; i < Math.min(buffer.byteLength, 4096); i++) {
            seen.add(view.getUint8(i));
        }
        nonZero = seen.size;
    }

    return { riff, wave, bytes: buffer.byteLength, nonZero, sampleRate, peak };
}"""


def log(message):
    print(f"  {message}", flush=True)


def load(page, name):
    page.set_input_files("input[type=file]", SAMPLES + name)
    page.wait_for_selector(".pdf-page canvas", timeout=60000)
    page.wait_for_timeout(3000)


def export(page, engine, fmt, wait_text):
    """Selects an engine and format, exports, and returns the decoded audio."""
    page.select_option("#export-engine", engine)
    page.wait_for_timeout(400)
    page.select_option("#export-format", fmt)
    page.click(f"button:has-text('{wait_text}')")
    page.wait_for_selector("audio", timeout=300000)
    page.wait_for_timeout(2500)
    return page.evaluate(DECODE_AUDIO)


def main():
    results = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/usr/bin/chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        page = context.new_page()

        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(3000)
        load(page, "mixed.pdf")

        # --- the server is detected and offered --------------------------------
        engine_options = page.locator("#export-engine option").all_inner_texts()
        log(f"engine options: {engine_options}")
        results.append(("engine dropdown offers the narrator voice", len(engine_options) >= 2))
        results.append(("narrator voice is enabled", "unavailable" not in engine_options[0]))

        voice_options = page.locator("#export-voice option").all_inner_texts()
        log(f"server voices: {voice_options}")
        results.append(("server voice list is populated", len(voice_options) >= 1))
        results.append(("voice names come from the server", "Lessac" in " ".join(voice_options)))

        # --- server engine, WAV ------------------------------------------------
        log("exporting with the server engine as WAV")
        server_wav = export(page, "Server", "Wav", "Save as WAV")
        log(f"server wav: {server_wav}")
        results.append(("server export is a WAV", bool(server_wav) and server_wav["riff"] and server_wav["wave"]))
        results.append(("server export is not silent", bool(server_wav) and server_wav["nonZero"] > 500))
        results.append(("server audio is at 22.05 kHz", bool(server_wav) and server_wav["sampleRate"] == 22050))

        sidebar = page.locator(".reader-sidebar").inner_text()
        results.append(("server export reported a duration", "about" in sidebar.lower()))

        # --- server engine, MP3 ------------------------------------------------
        log("exporting with the server engine as MP3")
        server_mp3 = export(page, "Server", "Mp3", "Save as MP3")
        log(f"server mp3: {server_mp3}")
        results.append(("server MP3 export produced audio", bool(server_mp3) and server_mp3["bytes"] > 2000))
        results.append(("server MP3 is not a uniform byte run", bool(server_mp3) and server_mp3["nonZero"] > 8))

        # --- offline engine still works ----------------------------------------
        log("exporting with the offline engine as WAV")
        offline_wav = export(page, "Offline", "Wav", "Save as WAV")
        log(f"offline wav: {offline_wav}")
        results.append(("offline export still works", bool(offline_wav) and offline_wav["riff"]))
        results.append(("offline export is not silent", bool(offline_wav) and offline_wav["nonZero"] > 500))

        # The two engines must not be producing byte-identical audio, otherwise the
        # server path would not actually be doing anything.
        if server_wav and offline_wav:
            different = server_wav["bytes"] != offline_wav["bytes"]
            log(f"server {server_wav['bytes']} bytes vs offline {offline_wav['bytes']} bytes")
            results.append(("the two engines produce different audio", different))

        # --- switching engines swaps the voice list ----------------------------
        page.select_option("#export-engine", "Offline")
        page.wait_for_timeout(400)
        offline_voices = page.locator("#export-voice option").all_inner_texts()
        log(f"offline voices: {offline_voices}")
        results.append(("offline engine shows its own voices", "Lessac" not in " ".join(offline_voices)))

        relevant = [e for e in errors if "favicon" not in e.lower()]
        log(f"console errors: {relevant[:4]}")
        results.append(("no console errors", len(relevant) == 0))

        browser.close()

    print("\n=== RESULTS ===")
    failed = 0
    for name, ok in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
        failed += 0 if ok else 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

"""Offline fallback test.

With the narration server stopped, the reader must still load, must not offer the
narrator voice, and must still export audio with the built-in engine.
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:12000/"
SAMPLES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "PdfReaderApp", "wwwroot", "samples") + os.sep


def main():
    results = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/usr/bin/chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_context(viewport={"width": 1600, "height": 1000}).new_page()

        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(3000)
        page.set_input_files("input[type=file]", SAMPLES + "mixed.pdf")
        page.wait_for_selector(".pdf-page canvas", timeout=60000)
        page.wait_for_timeout(3000)

        options = page.locator("#export-engine option").all_inner_texts()
        print(f"  engine options with server down: {options}", flush=True)
        results.append(("narrator voice is marked unavailable", any("unavailable" in o for o in options)))

        disabled = page.locator("#export-engine option[disabled]").count()
        results.append(("narrator voice is disabled", disabled >= 1))

        # The app must have fallen back to the offline engine, not left the server selected.
        selected = page.locator("#export-engine").input_value()
        print(f"  selected engine: {selected}", flush=True)
        results.append(("export falls back to the offline engine", selected == "Offline"))

        page.select_option("#export-format", "Wav")
        page.click("button:has-text('Save as WAV')")
        page.wait_for_selector("audio", timeout=300000)
        page.wait_for_timeout(2000)

        info = page.evaluate("""async () => {
            const el = document.querySelector('audio');
            const buffer = await (await fetch(el.src)).arrayBuffer();
            const view = new DataView(buffer);
            let nonZero = 0;
            for (let i = 44; i + 1 < buffer.byteLength; i += 2) {
                if (view.getInt16(i, true) !== 0) { nonZero++; }
            }
            return { bytes: buffer.byteLength, nonZero };
        }""")
        print(f"  fallback export: {info}", flush=True)
        results.append(("fallback export produced audio", info["bytes"] > 2000))
        results.append(("fallback export is not silent", info["nonZero"] > 500))

        relevant = [e for e in errors if "favicon" not in e.lower()]
        # A refused connection is the browser logging the probe against a server we
        # deliberately stopped; it is a network log, not an application fault.
        network_only = [e for e in relevant if "ERR_CONNECTION_REFUSED" in e]
        js_errors = [e for e in relevant if "ERR_CONNECTION_REFUSED" not in e]
        print(f"  network logs: {network_only[:2]}", flush=True)
        print(f"  js errors: {js_errors[:4]}", flush=True)
        results.append(("the only log is the expected refused connection", len(network_only) >= 1))
        results.append(("no javascript errors", len(js_errors) == 0))

        browser.close()

    print("\n=== RESULTS ===")
    failed = 0
    for name, ok in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
        failed += 0 if ok else 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

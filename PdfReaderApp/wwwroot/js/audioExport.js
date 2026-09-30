// Offline text-to-speech export.
//
// The Web Speech API can only play audio; it cannot hand back samples. To let the reader
// save what it reads, passages are synthesised here with meSpeak (eSpeak compiled to
// JavaScript) which returns raw PCM, then written out as WAV or encoded to MP3 with lamejs.
// Both engines are vendored under /lib so export works without network access.

const MESPEAK_SCRIPT = './lib/mespeak/mespeak.js';
const LAME_SCRIPT = './lib/lamejs/lame.min.js';
const SAMPLE_RATE = 22050;
const SYNTH_TIMEOUT_MS = 30000;

// piper's own inter-sentence pause. The reader's gap setting is applied separately, when
// the passages are joined, so the slider keeps meaning the same thing on both engines.
const SERVER_SENTENCE_SILENCE_MS = 200;

// Paths are resolved by meSpeak relative to the directory its own script lives in.
const VOICE_PATHS = {
    'en': 'voices/en/en.json',
    'en-us': 'voices/en/en-us.json',
    'en-n': 'voices/en/en-n.json',
    'en-rp': 'voices/en/en-rp.json',
    'en-sc': 'voices/en/en-sc.json',
    'en-wm': 'voices/en/en-wm.json',
    'de': 'voices/de.json',
    'es': 'voices/es.json',
    'fr': 'voices/fr.json',
};

let mespeakLoad;
let lameLoad;
const loadedVoices = new Set();
let exportCancelled = false;

// Loads a classic script once and resolves when it has executed.
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(script);
    });
}

function ensureMespeak() {
    if (!mespeakLoad) {
        mespeakLoad = loadScript(MESPEAK_SCRIPT);
    }

    return mespeakLoad;
}

function ensureLame() {
    if (!lameLoad) {
        lameLoad = loadScript(LAME_SCRIPT);
    }

    return lameLoad;
}

// Voices are loaded through meSpeak's own queue, which also proves the engine is up.
function ensureVoice(voiceId) {
    const id = VOICE_PATHS[voiceId] ? voiceId : 'en-us';
    if (loadedVoices.has(id)) {
        return Promise.resolve(id);
    }

    const path = VOICE_PATHS[id];
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The speech engine did not start in time.')), SYNTH_TIMEOUT_MS);
        window.meSpeak.loadVoice(path, (success, message) => {
            clearTimeout(timer);
            if (!success) {
                reject(new Error(message || `Could not load voice "${id}".`));
                return;
            }

            loadedVoices.add(id);
            resolve(id);
        });
    });
}

// meSpeak expresses speed in words per minute, pitch on a 0-99 scale and amplitude on a
// 0-200 scale, so the user facing multipliers are converted to those ranges here.
function toEngineOptions(options) {
    return {
        rawdata: 'array',
        speed: Math.round(175 * clamp(options.speed ?? 1, 0.5, 2.5)),
        pitch: Math.round(50 * clamp(options.pitch ?? 1, 0.1, 2)),
        amplitude: Math.round(100 * clamp(options.amplitude ?? 1, 0, 1)),
        wordgap: Math.max(0, Math.round(options.wordgap ?? 0)),
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function synthesizeOffline(text, options) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Synthesis timed out.')), SYNTH_TIMEOUT_MS);
        window.meSpeak.speak(text, toEngineOptions(options), (success, id, stream) => {
            clearTimeout(timer);
            if (!success) {
                reject(new Error('The speech engine could not synthesise this passage.'));
                return;
            }

            resolve(new Uint8Array(stream));
        });
    });
}

// The server engine returns a finished WAV per passage, so there is nothing to encode
// here beyond what the caller already does for the offline engine.
async function synthesizeServer(text, options) {
    const base = (options.serverUrl || '').replace(/\/+$/, '');
    if (!base) {
        throw new Error('No narration server is configured.');
    }

    let response;
    try {
        response = await fetch(`${base}/api/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                voice: options.voice,
                rate: clamp(options.speed ?? 1, 0.5, 2.5),
                // piper pauses after each sentence for prosody; that is separate from the
                // reader's gap slider, which spaces whole passages apart in the assembly loop.
                sentenceSilenceMs: SERVER_SENTENCE_SILENCE_MS,
            }),
        });
    } catch {
        throw new Error('The narration server could not be reached.');
    }

    if (!response.ok) {
        let detail = '';
        try {
            const problem = await response.json();
            detail = problem && (problem.detail || problem.title) ? ` ${problem.detail || problem.title}` : '';
        } catch {
            // The error body was not JSON; the status alone will have to do.
        }

        throw new Error(`The narration server returned ${response.status}.${detail}`);
    }

    return new Uint8Array(await response.arrayBuffer());
}

/// Reports whether a narration server is reachable and what it offers.
export async function probeServer(baseUrl) {
    const base = (baseUrl || '').replace(/\/+$/, '');
    if (!base) {
        return { available: false, reason: 'No narration server is configured.' };
    }

    try {
        const response = await fetch(`${base}/api/health`);
        if (!response.ok) {
            return { available: false, reason: `The narration server returned ${response.status}.` };
        }

        const health = await response.json();
        if (!health.installed) {
            return { available: false, reason: 'The narration engine is not installed on the server.' };
        }

        if (!health.voices) {
            return { available: false, reason: 'The narration server has no voices installed.' };
        }

        return { available: true, reason: '', voices: health.voices };
    } catch {
        return { available: false, reason: 'The narration server could not be reached.' };
    }
}

/// The voices the narration server can synthesise with.
export async function listServerVoices(baseUrl) {
    const base = (baseUrl || '').replace(/\/+$/, '');
    if (!base) {
        return [];
    }

    const response = await fetch(`${base}/api/voices`);
    if (!response.ok) {
        throw new Error(`The narration server returned ${response.status}.`);
    }

    const payload = await response.json();
    return payload.voices || [];
}

// Pulls the sample data and format out of the RIFF header meSpeak returns.
function parseWav(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let dataOffset = -1;
    let dataLength = 0;
    let channels = 1;
    let sampleRate = SAMPLE_RATE;
    let bitsPerSample = 16;

    while (offset + 8 <= bytes.length) {
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        const size = view.getUint32(offset + 4, true);

        if (id === 'fmt ') {
            channels = view.getUint16(offset + 10, true);
            sampleRate = view.getUint32(offset + 12, true);
            bitsPerSample = view.getUint16(offset + 22, true);
        } else if (id === 'data') {
            dataOffset = offset + 8;
            dataLength = Math.min(size, bytes.length - dataOffset);
            break;
        }

        offset += 8 + size + (size & 1);
    }

    if (dataOffset < 0) {
        throw new Error('The synthesised audio was not in a readable format.');
    }

    const sampleCount = Math.floor(dataLength / 2);
    const samples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        samples[i] = view.getInt16(dataOffset + (i * 2), true);
    }

    return { samples, sampleRate, channels, bitsPerSample };
}

function buildWav(samples, sampleRate) {
    const dataLength = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeText = (offset, text) => {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    };

    writeText(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, dataLength, true);

    new Int16Array(buffer, 44).set(samples);
    return new Uint8Array(buffer);
}

function concatInt16(parts, totalSamples) {
    const result = new Int16Array(totalSamples);
    let position = 0;
    for (const part of parts) {
        result.set(part, position);
        position += part.length;
    }

    return result;
}

async function notify(dotnet, stage, current, total, message) {
    if (!dotnet) {
        return;
    }

    try {
        await dotnet.invokeMethodAsync('OnExportProgress', stage, current, total, message ?? '');
    } catch {
        // The component may have been disposed while exporting.
    }
}

export function supported() {
    return typeof document !== 'undefined' && typeof Blob !== 'undefined';
}

export function listVoices() {
    return Object.keys(VOICE_PATHS).map((id) => ({ id }));
}

/// Synthesises the given passages and returns a downloadable audio file.
/// options: { format, voice, speed, pitch, amplitude, wordgap, bitrate, gapMs, fileName }
export async function exportPassages(passages, options, dotnet) {
    const text = (passages || []).filter((p) => p && p.trim().length > 0);
    if (text.length === 0) {
        throw new Error('There is no text to export.');
    }

    exportCancelled = false;

    // The server engine needs no local loading, and its voices are piper ids rather than
    // the bundled meSpeak ones, so the two engines are prepared differently.
    const useServer = options.engine === 'server';

    if (useServer) {
        await notify(dotnet, 'loading', 0, text.length, 'Contacting the narration server');
    } else {
        await notify(dotnet, 'loading', 0, text.length, 'Starting the offline speech engine');
        await ensureMespeak();
        await ensureVoice(options.voice);
    }

    const synthesize = useServer ? synthesizeServer : synthesizeOffline;

    const format = options.format === 'wav' ? 'wav' : 'mp3';
    let encoder = null;
    if (format === 'mp3') {
        await ensureLame();
        if (!window.lamejs) {
            throw new Error('The MP3 encoder could not be loaded.');
        }

        encoder = new window.lamejs.Mp3Encoder(1, SAMPLE_RATE, options.bitrate || 128);
    }

    const gapSamples = Math.max(0, Math.round(SAMPLE_RATE * ((options.gapMs ?? 250) / 1000)));
    const silence = new Int16Array(gapSamples);
    const pcmParts = [];
    const mp3Parts = [];
    let totalSamples = 0;

    for (let index = 0; index < text.length; index++) {
        if (exportCancelled) {
            throw new Error('cancelled');
        }

        const preview = text[index].trim().replace(/\s+/g, ' ').slice(0, 60);
        await notify(dotnet, 'synthesizing', index, text.length, preview);

        const wav = await synthesize(text[index], options);
        const { samples, sampleRate } = parseWav(wav);
        if (sampleRate !== SAMPLE_RATE) {
            throw new Error('The speech engine returned an unexpected sample rate.');
        }

        if (format === 'wav') {
            pcmParts.push(samples);
            totalSamples += samples.length;
        } else {
            pushMp3(mp3Parts, encoder.encodeBuffer(samples));
        }

        // A short silence keeps consecutive passages from running together.
        if (index < text.length - 1 && gapSamples > 0) {
            if (format === 'wav') {
                pcmParts.push(silence);
                totalSamples += silence.length;
            } else {
                pushMp3(mp3Parts, encoder.encodeBuffer(silence));
            }
        }

        await notify(dotnet, 'synthesizing', index + 1, text.length, preview);
        // Yield so the progress bar can repaint between passages.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    let bytes;
    let mime;
    if (format === 'wav') {
        bytes = buildWav(concatInt16(pcmParts, totalSamples), SAMPLE_RATE);
        mime = 'audio/wav';
    } else {
        pushMp3(mp3Parts, encoder.flush());
        bytes = concatBytes(mp3Parts);
        mime = 'audio/mpeg';
    }

    await notify(dotnet, 'encoding', text.length, text.length, 'Finishing the audio file');

    const blob = new Blob([bytes], { type: mime });
    return {
        url: URL.createObjectURL(blob),
        fileName: options.fileName || (format === 'wav' ? 'reading.wav' : 'reading.mp3'),
        mimeType: mime,
        bytes: bytes.length,
        seconds: format === 'wav' ? totalSamples / SAMPLE_RATE : estimateMp3Seconds(bytes.length, options.bitrate || 128),
        passages: text.length,
    };
}

function pushMp3(parts, encoded) {
    if (encoded && encoded.length) {
        parts.push(new Uint8Array(encoded));
    }
}

function estimateMp3Seconds(byteCount, bitrateKbps) {
    return (byteCount * 8) / (bitrateKbps * 1000);
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let position = 0;
    for (const part of parts) {
        result.set(part, position);
        position += part.length;
    }

    return result;
}

export function cancelExport() {
    exportCancelled = true;
    if (window.meSpeak && window.meSpeak.stop) {
        try {
            window.meSpeak.stop();
        } catch {
            // Stopping an idle engine is harmless.
        }
    }
}

export function download(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

export function release(url) {
    if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
    }
}
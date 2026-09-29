// Text to speech bridge around the Web Speech API (window.speechSynthesis).
let dotNetRef = null;
let currentUtterance = null;
let activeId = 0;

function supported() {
    return typeof window.speechSynthesis !== 'undefined'
        && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

function mapVoice(voice, index) {
    return {
        name: voice.name,
        lang: voice.lang,
        local: voice.localService === true,
        isDefault: voice.default === true,
        index: index,
    };
}

function getVoices() {
    if (!supported()) {
        return [];
    }
    return window.speechSynthesis.getVoices().map(mapVoice);
}

// Voices load asynchronously in most browsers, so wait for the first batch.
function waitForVoices(timeoutMs) {
    return new Promise((resolve) => {
        if (!supported()) {
            resolve([]);
            return;
        }

        const existing = window.speechSynthesis.getVoices();
        if (existing.length > 0) {
            resolve(existing.map(mapVoice));
            return;
        }

        let settled = false;
        const done = () => {
            if (settled) {
                return;
            }
            settled = true;
            window.speechSynthesis.removeEventListener('voiceschanged', done);
            clearTimeout(timer);
            resolve(window.speechSynthesis.getVoices().map(mapVoice));
        };

        const timer = setTimeout(done, timeoutMs || 3000);
        window.speechSynthesis.addEventListener('voiceschanged', done);
    });
}

function notifyState(state) {
    if (dotNetRef) {
        dotNetRef.invokeMethodAsync('OnSpeechStateChanged', state);
    }
}

function notifyBoundary(id, charIndex, charLength) {
    if (dotNetRef) {
        dotNetRef.invokeMethodAsync('OnSpeechBoundary', id, charIndex, charLength);
    }
}

function speak(id, text, options) {
    return new Promise((resolve) => {
        if (!supported()) {
            resolve('unsupported');
            return;
        }

        const settings = options || {};
        const utterance = new SpeechSynthesisUtterance(text);

        const voices = window.speechSynthesis.getVoices();
        const voice = voices.find((candidate) => candidate.name === settings.voiceName);
        if (voice) {
            utterance.voice = voice;
        }
        utterance.lang = settings.lang || (voice ? voice.lang : 'en-US');
        utterance.rate = typeof settings.rate === 'number' ? settings.rate : 1;
        utterance.pitch = typeof settings.pitch === 'number' ? settings.pitch : 1;
        utterance.volume = typeof settings.volume === 'number' ? settings.volume : 1;

        let settled = false;
        const finish = (status) => {
            if (settled) {
                return;
            }
            settled = true;
            if (currentUtterance === utterance) {
                currentUtterance = null;
            }
            resolve(status);
        };

        utterance.onstart = () => notifyState('speaking');
        utterance.onend = () => finish('ended');
        utterance.onerror = (event) => finish(event && event.error === 'canceled' ? 'cancelled' : 'error');
        utterance.onboundary = (event) => {
            if (event.name === 'word' || event.name === 'sentence' || !event.name) {
                notifyBoundary(id, event.charIndex || 0, event.charLength || 0);
            }
        };

        activeId = id;
        currentUtterance = utterance;
        window.speechSynthesis.speak(utterance);
    });
}

function cancel() {
    if (!supported()) {
        return;
    }
    activeId = 0;
    window.speechSynthesis.cancel();
    notifyState('idle');
}

function pause() {
    if (!supported()) {
        return;
    }
    window.speechSynthesis.pause();
    notifyState('paused');
}

function resume() {
    if (!supported()) {
        return;
    }
    window.speechSynthesis.resume();
    notifyState('speaking');
}

function getState() {
    if (!supported()) {
        return 'unsupported';
    }
    if (window.speechSynthesis.speaking) {
        return window.speechSynthesis.paused ? 'paused' : 'speaking';
    }
    return 'idle';
}

function init(reference) {
    dotNetRef = reference;
    notifyState(getState());
}

function dispose() {
    cancel();
    dotNetRef = null;
}

window.speechInterop = {
    init,
    dispose,
    supported,
    getVoices,
    waitForVoices,
    speak,
    cancel,
    pause,
    resume,
    getState,
};

export default window.speechInterop;
export {
    init,
    dispose,
    supported,
    getVoices,
    waitForVoices,
    speak,
    cancel,
    pause,
    resume,
    getState,
};
// DOM references
const recordBtn = document.getElementById("recordBtn");
const statusTag = document.getElementById("statusTag");

const pitchRange = document.getElementById("pitchRange");
const pitchValue = document.getElementById("pitchValue");

const echoRange = document.getElementById("echoRange");
const echoValue = document.getElementById("echoValue");

const tempoRange = document.getElementById("tempoRange");
const tempoValue = document.getElementById("tempoValue");

const beatStyleSelect = document.getElementById("beatStyle");

const applyFxBtn = document.getElementById("applyFxBtn");
const fxPlayer = document.getElementById("fxPlayer");
const fxTag = document.getElementById("fxTag");
const playWithBeatBtn = document.getElementById("playWithBeatBtn");

let mediaRecorder;
let audioChunks = [];
let audioBlob;
let audioBuffer;
let isRecording = false;

let beatInterval = null;
let beatStep = 0;
let beatRunning = false;

// ----------------------
// UI display updates
// ----------------------
pitchRange.addEventListener("input", () => {
  const factor = parseFloat(pitchRange.value);
  const pct = Math.round((factor - 1) * 100);
  pitchValue.textContent = pct >= 0 ? `+${pct}%` : `${pct}%`;
});

echoRange.addEventListener("input", () => {
  echoValue.textContent = echoRange.value;
});

tempoRange.addEventListener("input", () => {
  tempoValue.textContent = `${tempoRange.value} BPM`;
});

// ----------------------
// Recording setup
// ----------------------
async function initMedia() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = (e) => {
    audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    audioChunks = [];

    statusTag.textContent = "Recorded";
    statusTag.className = "status-chip status-ready";

    const arrayBuffer = await audioBlob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  };
}

recordBtn.addEventListener("click", async () => {
  if (!mediaRecorder) {
    await initMedia();
  }

  if (!isRecording) {
    audioChunks = [];
    mediaRecorder.start();
    isRecording = true;

    recordBtn.textContent = "■ Stop";
    statusTag.textContent = "Recording…";
    statusTag.className = "status-chip status-warn";
  } else {
    mediaRecorder.stop();
    isRecording = false;

    recordBtn.textContent = "● Record";
    // statusTag will update in onstop
  }
});

// ----------------------
// Apply FX (Pitch + Echo only)
// ----------------------
applyFxBtn.addEventListener("click", async () => {
  if (!audioBuffer) {
    fxTag.textContent = "No audio yet";
    fxTag.className = "status-chip status-warn";
    return;
  }

  const pitchFactor = parseFloat(pitchRange.value); // 0.5..1.5
  const echoAmount  = parseFloat(echoRange.value);  // 0..0.6

  const sampleRate = audioBuffer.sampleRate;
  const duration   = audioBuffer.duration;
  const extraTailSeconds = 2.0; // let short echo tail ring out

  // Offline render for clean processed audio
  const offlineCtx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.ceil((duration + extraTailSeconds) * sampleRate),
    sampleRate: sampleRate
  });

  // voice source
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = pitchFactor; // pitch shift by speed

  // we'll mix into mainGain
  const mainGain = offlineCtx.createGain();
  mainGain.gain.value = 1.0; // keep natural loudness

  if (echoAmount > 0) {
    // mono slapback echo with feedback
    const delay = offlineCtx.createDelay();
    delay.delayTime.value = 0.25; // ~250ms slap

    const feedback = offlineCtx.createGain();
    feedback.gain.value = Math.min(echoAmount * 1.2, 0.7);

    const wet = offlineCtx.createGain();
    wet.gain.value = 0.3 + echoAmount * 0.3;

    const lp = offlineCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3500 - echoAmount * 1000; // darker if more echo

    const dry = offlineCtx.createGain();
    dry.gain.value = 1.0;

    // dry path straight to main
    source.connect(dry);
    dry.connect(mainGain);

    // echo / feedback path
    source.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);

    delay.connect(lp);
    lp.connect(wet);
    wet.connect(mainGain);

  } else {
    // no echo, just dry voice
    source.connect(mainGain);
  }

  // light compressor to stop clipping and make you sound closer
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 30;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.25;

  mainGain.connect(compressor);
  compressor.connect(offlineCtx.destination);

  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();

  // Convert to WAV blob + load in audio element
  const processedBlob = audioBufferToWavBlob(renderedBuffer);
  fxPlayer.src = URL.createObjectURL(processedBlob);

  fxTag.textContent = "FX ready";
  fxTag.className = "status-chip status-ready";

  // stop beat tied to old buffer
  stopBeatLoop();
});

// ----------------------
// Drum synthesis (kick / snare / hat)
// ----------------------
function playKick(level = 0.4) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(90, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.12);

  gain.gain.setValueAtTime(level, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc.stop(ctx.currentTime + 0.15);
}

function playSnare(level = 0.25) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const len = 0.12 * ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = ctx.createBufferSource();
  noise.buffer = buf;

  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1800;
  band.Q = 1.2;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

  noise.connect(band);
  band.connect(gain);
  gain.connect(ctx.destination);

  noise.start();
  noise.stop(ctx.currentTime + 0.12);
}

function playHat(level = 0.15) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const len = 0.02 * ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = ctx.createBufferSource();
  noise.buffer = buf;

  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 6000;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);

  noise.connect(high);
  high.connect(gain);
  gain.connect(ctx.destination);

  noise.start();
  noise.stop(ctx.currentTime + 0.05);
}

// ----------------------
// Beat patterns
// ----------------------
function runBeatStep(step, style) {
  if (style === "boom") {
    // classic boom bap pocket
    if (step === 0 || step === 4) playKick(0.45);
    if (step === 2 || step === 6) playSnare(0.28);
    if (step % 2 === 0) playHat(0.13);
  }

  if (style === "four") {
    // 4-on-the-floor: house/club
    if (step % 2 === 0) playKick(0.4);
    if (step === 6) playSnare(0.25);
    if (step % 2 === 1) playHat(0.14);
  }

  if (style === "trap") {
    // trap-ish: sparse heavy kicks and constant hats
    if (step === 0 || step === 5) playKick(0.35);
    if (step === 4) playSnare(0.25);
    playHat(0.09);
  }
}

function getStepMsFromTempo(bpm) {
  const beatMs = 60000 / bpm; // ms per quarter note
  return beatMs / 2;          // 8th note step
}

// ----------------------
// Beat loop sync
// ----------------------
function startBeatLoop() {
  if (!fxPlayer.src) return; // need processed voice first
  if (beatRunning) {
    stopBeatLoop();
    return;
  }

  fxPlayer.currentTime = 0;
  fxPlayer.play();

  beatRunning = true;
  beatStep = 0;

  const bpm = parseInt(tempoRange.value, 10);
  const style = beatStyleSelect.value;
  const stepMs = getStepMsFromTempo(bpm);

  beatInterval = setInterval(() => {
    if (fxPlayer.paused || fxPlayer.ended) {
      stopBeatLoop();
      return;
    }

    runBeatStep(beatStep, style);
    beatStep = (beatStep + 1) % 8;
  }, stepMs);
}

function stopBeatLoop() {
  beatRunning = false;
  if (beatInterval) {
    clearInterval(beatInterval);
    beatInterval = null;
  }
  if (!fxPlayer.paused) {
    fxPlayer.pause();
  }
}

playWithBeatBtn.addEventListener("click", startBeatLoop);
fxPlayer.addEventListener("pause", stopBeatLoop);
fxPlayer.addEventListener("ended", stopBeatLoop);

// ----------------------
// WAV helper
// ----------------------
function audioBufferToWavBlob(buf) {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const len = buf.length * numCh * 2; // 16-bit PCM
  const buffer = new ArrayBuffer(44 + len);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + len, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, len, true);

  let offset = 44;
  for (let i = 0; i < buf.length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const sample = buf.getChannelData(ch)[i];
      const s = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

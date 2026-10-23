const transcript = document.querySelector('#transcript');
const recordBtn = document.querySelector('#recordBtn');
const clearBtn = document.querySelector('#clearBtn');
const saveBtn = document.querySelector('#saveBtn');
const language = document.querySelector('#language');
const provider = document.querySelector('#provider');
const historyList = document.querySelector('#historyList');
const search = document.querySelector('#search');
const count = document.querySelector('#count');
const timer = document.querySelector('#timer');
const state = document.querySelector('#recordingState');
const support = document.querySelector('#supportMessage');
let recognition, recording = false, startedAt, timerHandle, records = [];
let mediaRecorder, audioStream, audioChunks = [];
let geminiSocket, geminiContext, geminiProcessor, geminiSetupTimeout, geminiFinalText = '', geminiInterimText = '', geminiConnecting = false;

function setupSpeech() {
  const API = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!API) { recordBtn.disabled = true; support.textContent = 'Live speech recognition is not supported in this browser. Try Chrome or Edge.'; return; }
  recognition = new API(); recognition.continuous = true; recognition.interimResults = true; recognition.lang = language.value;
  recognition.onresult = event => { let finalText = ''; let interim = ''; for (let i = event.resultIndex; i < event.results.length; i++) { const text = event.results[i][0].transcript; event.results[i].isFinal ? finalText += text + ' ' : interim += text; } if (finalText) transcript.textContent = `${transcript.textContent.replace(/\s*\[.*$/, '').trim()} ${finalText}`.trim() + (interim ? ` [${interim}]` : ''); else { const base = transcript.textContent.replace(/\s*\[.*$/, '').trim(); transcript.textContent = base + (interim ? ` [${interim}]` : ''); } };
  recognition.onerror = e => {
    // Chrome can emit a transient `network` error when its recognition
    // service is unavailable. Do not call stopRecording() here: that was the
    // reason the button immediately returned to its default state.
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      support.textContent = 'Microphone permission was denied. Allow microphone access for this site and try again.';
      stopRecording();
      return;
    }
    if (e.error === 'network') {
      support.textContent = 'Speech service is temporarily unavailable. The recording session is still active; you can type or paste text and save it.';
      return;
    }
    support.textContent = `Recognition issue: ${e.error}. The recording session is still active.`;
  };
  recognition.onend = () => {
    // Some browsers end a continuous session after a network hiccup. Keep
    // the UI in the active state and retry after the browser has released the
    // previous recognition instance.
    if (recording) {
      window.setTimeout(() => {
        if (recording) try { recognition.start(); } catch (_) {}
      }, 250);
    }
  };
}
function stopRecording() {
  if (provider.value === 'gemini') return stopGeminiRecording();
  recording = false;
  state.textContent = 'Ready';
  state.classList.remove('live');
  recordBtn.innerHTML = '<span class="mic">●</span> Start speaking';
  clearInterval(timerHandle);
  if (recognition) try { recognition.stop(); } catch (_) {}
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (audioStream) audioStream.getTracks().forEach(track => track.stop());
  support.textContent = audioChunks.length ? 'Recording stopped. Transcribing audio…' : support.textContent;
}
async function startRecording() {
  if (provider.value === 'gemini') return startGeminiRecording();
  recording = true;
  startedAt = Date.now();
  state.textContent = 'Listening…';
  state.classList.add('live');
  recordBtn.textContent = 'Stop recording';
  timerHandle = setInterval(() => { const seconds = Math.floor((Date.now() - startedAt) / 1000); timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`; }, 250);
  // Keep an audio fallback running even when the browser's recognition
  // network service is unavailable. This is what the Whisper adapter consumes.
  if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({audio: true});
      audioChunks = [];
      mediaRecorder = new MediaRecorder(audioStream);
      mediaRecorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
      mediaRecorder.onstop = uploadAudio;
      mediaRecorder.start(250);
      support.textContent = 'Microphone active. Speak naturally; live words will appear when the speech service is available.';
    } catch (_) {
      support.textContent = 'Microphone access was unavailable. You can still type or paste text and save it.';
    }
  }
  if (recognition) { recognition.lang = language.value; try { recognition.start(); } catch (_) {} }
}
function pcmBase64(input, inputRate) {
  const ratio = inputRate / 16000;
  const length = Math.round(input.length / ratio);
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, input[Math.min(input.length - 1, Math.round(i * ratio))]));
    pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function renderGeminiText() {
  const base = geminiFinalText.trim();
  transcript.textContent = `${base}${base && geminiInterimText ? ' ' : ''}${geminiInterimText}`.trim();
}
async function startGeminiRecording() {
  recording = false; geminiConnecting = true; state.textContent = 'Connecting to Gemini…'; state.classList.add('live'); recordBtn.textContent = 'Cancel connection'; recordBtn.disabled = false;
  geminiFinalText = ''; geminiInterimText = '';
  try {
    const tokenResponse = await fetch('/api/gemini/session', {method: 'POST'});
    if (!tokenResponse.ok) { const error = await tokenResponse.json().catch(() => ({})); throw new Error(error.detail || 'Gemini is not configured'); }
    const {token, model} = await tokenResponse.json();
    // Gemini ephemeral-token sessions currently use the v1alpha constrained
    // WebSocket endpoint. Using v1beta can open the socket but never emit the
    // setupComplete acknowledgement.
    geminiSocket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`);
    geminiSocket.onopen = () => {
      geminiSocket.send(JSON.stringify({setup: {model: `models/${model}`, generationConfig: {responseModalities: ['TEXT']}, inputAudioTranscription: {languageCodes: []}}}));
      support.textContent = 'Gemini connected. Waiting for the listening confirmation…';
      geminiSetupTimeout = window.setTimeout(() => {
        if (geminiConnecting) {
          support.textContent = 'Gemini connected but did not acknowledge the transcription setup within 10 seconds. Check the selected model and API access.';
          stopGeminiRecording();
        }
      }, 10000);
    };
    geminiSocket.onmessage = async event => {
      let raw = event.data;
      if (typeof raw !== 'string') {
        if (raw instanceof Blob) raw = await raw.text();
        else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      }
      let message;
      try { message = JSON.parse(raw); } catch (_) { support.textContent = 'Gemini returned an unreadable setup message.'; return; }
      if (message.error) { support.textContent = `Gemini rejected the session: ${message.error.message || 'unknown protocol error'}`; stopGeminiRecording(); return; }
      if (message.setupComplete) { clearTimeout(geminiSetupTimeout); beginGeminiAudio(); return; }
      const content = message.serverContent;
      if (!content) return;
      if (content.interimInputTranscription) { geminiInterimText = content.interimInputTranscription.text || ''; renderGeminiText(); }
      if (content.inputTranscription) { geminiFinalText += `${content.inputTranscription.text || ''} `; geminiInterimText = ''; renderGeminiText(); }
    };
    geminiSocket.onerror = () => { support.textContent = 'Gemini Live connection failed. Check GEMINI_API_KEY, model access, and API quota.'; stopGeminiRecording(); };
    geminiSocket.onclose = event => { if (geminiConnecting) { support.textContent = `Gemini closed the setup connection${event.reason ? `: ${event.reason}` : '.'}`; stopGeminiRecording(); } };
  } catch (error) { support.textContent = error.message; stopGeminiRecording(); }
}
async function beginGeminiAudio() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({audio: true});
    geminiContext = new AudioContext({sampleRate: 16000});
    const source = geminiContext.createMediaStreamSource(audioStream);
    geminiProcessor = geminiContext.createScriptProcessor(4096, 1, 1);
    geminiProcessor.onaudioprocess = event => {
      if (recording && geminiSocket?.readyState === WebSocket.OPEN) {
        geminiSocket.send(JSON.stringify({realtimeInput: {audio: {data: pcmBase64(event.inputBuffer.getChannelData(0), geminiContext.sampleRate), mimeType: 'audio/pcm;rate=16000'}}}));
      }
    };
    source.connect(geminiProcessor); geminiProcessor.connect(geminiContext.destination);
    geminiConnecting = false; recording = true; startedAt = Date.now(); state.textContent = 'Listening with Gemini…'; recordBtn.textContent = 'Stop recording'; support.textContent = 'Gemini Live is transcribing in real time.';
    timerHandle = setInterval(() => { const seconds = Math.floor((Date.now() - startedAt) / 1000); timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`; }, 250);
  } catch (error) { support.textContent = `Gemini is ready, but microphone access failed: ${error.message}`; stopGeminiRecording(); }
}
function stopGeminiRecording() {
  recording = false; geminiConnecting = false; clearTimeout(geminiSetupTimeout); state.textContent = 'Ready'; state.classList.remove('live'); recordBtn.innerHTML = '<span class="mic">●</span> Start speaking'; clearInterval(timerHandle);
  if (geminiSocket?.readyState === WebSocket.OPEN) geminiSocket.send(JSON.stringify({realtimeInput: {audioStreamEnd: true}}));
  if (geminiProcessor) { geminiProcessor.disconnect(); geminiProcessor = null; }
  if (geminiContext) { geminiContext.close(); geminiContext = null; }
  if (audioStream) { audioStream.getTracks().forEach(track => track.stop()); audioStream = null; }
  if (geminiSocket) { window.setTimeout(() => geminiSocket?.close(), 800); geminiSocket = null; }
  if (geminiFinalText.trim()) support.textContent = 'Gemini transcription complete. Review the text and save it to history.';
}
async function uploadAudio() {
  if (!audioChunks.length) return;
  const form = new FormData();
  form.append('file', new Blob(audioChunks, {type: mediaRecorder?.mimeType || 'audio/webm'}), 'recording.webm');
  try {
    const response = await fetch('/api/transcribe-audio', {method: 'POST', body: form});
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      support.textContent = error.detail || 'No transcription provider is configured. Set WHISPER_URL or use Chrome/Edge for live browser recognition.';
      return;
    }
    const result = await response.json();
    if (result.text) {
      transcript.textContent = result.text;
      support.textContent = 'Transcription complete. Review the text and save it to history.';
    } else {
      support.textContent = 'The transcription service returned no text.';
    }
  } catch (_) {
    support.textContent = 'Audio was captured locally. Configure WHISPER_URL to turn it into text.';
  }
}
recordBtn.onclick = () => (recording || geminiConnecting) ? stopRecording() : startRecording();
clearBtn.onclick = () => { transcript.textContent = ''; timer.textContent = '00:00'; };
language.onchange = () => { if (recognition) recognition.lang = language.value; };
saveBtn.onclick = async () => { const text = transcript.textContent.replace(/\s*\[.*$/, '').trim(); if (!text) return alert('Say something or type a transcript first.'); await fetch('/api/transcriptions', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text, language:language.value, source:provider.value})}); await loadHistory(); if (recording) stopRecording(); };
async function loadHistory() { records = await (await fetch('/api/transcriptions')).json(); renderHistory(); }
function renderHistory() { const query = search.value.toLowerCase(); const shown = records.filter(r => r.text.toLowerCase().includes(query)); count.textContent = records.length; historyList.innerHTML = shown.length ? shown.map(r => `<article class="history-item"><p>${escapeHtml(r.text)}</p><div class="history-meta"><span>${new Date(r.created_at).toLocaleString()} · ${r.language}</span><span class="item-actions"><button onclick="editRecord(${r.id}, '${encodeURIComponent(r.text)}')">Edit</button><button onclick="deleteRecord(${r.id})">Delete</button></span></div></article>`).join('') : '<p class="support-message">No saved transcripts yet.</p>'; }
window.deleteRecord = async id => { await fetch(`/api/transcriptions/${id}`, {method:'DELETE'}); loadHistory(); };
window.editRecord = async (id, encoded) => { const value = prompt('Edit transcript', decodeURIComponent(encoded)); if (value && value.trim()) { await fetch(`/api/transcriptions/${id}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:value})}); loadHistory(); } };
function escapeHtml(value) { return value.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
async function loadProviders() { try { const available = await (await fetch('/api/providers')).json(); for (const option of provider.options) { if (option.value !== 'browser' && !available[option.value]?.available) { option.disabled = true; option.textContent += ' (not configured)'; } } provider.value = available.gemini?.available ? 'gemini' : 'browser'; if (!available.gemini?.available) support.textContent = 'Gemini is the default provider, but it is not configured. Using browser recognition until GEMINI_API_KEY is set.'; } catch (_) { provider.value = 'browser'; } }
provider.onchange = () => { if (recording) stopRecording(); };
search.oninput = renderHistory; setupSpeech(); loadProviders(); loadHistory();

/* Echo — browser-based family voice companion.
 * Browser phrases use device voices; optional voice-model generation runs only on the user's local Apple Silicon Mac.
 * Voice samples are processed only after explicit consent and are never sent to a cloud voice service.
 */
"use strict";

const MAX_CLIP_SECONDS = 30;
const MAX_CLIP_BYTES = 5 * 1024 * 1024;
let voiceClipDbPromise = null;

const state = {
  currentLang: "en-US",
  selectedVoiceURI: "",
  profiles: [],
  activePerson: null,
  editingProfileId: null,
  recognition: null,
  recognitionActive: false,
  mediaRecorder: null,
  mediaStream: null,
  preparingRecording: false,
  recordingAttempt: 0,
  clipRecording: false,
  audioChunks: [],
  pendingVoiceClip: null,
  existingVoiceClip: null,
  previewUrl: "",
  profileAudioUrls: new Map(),
  recordingTimer: null,
  recordingStartedAt: 0,
  discardNextRecorderStop: false,
  savingProfile: false,
  voices: [],
  localAiAvailable: false,
  localAiChecking: false,
  generatingLocalAi: false,
  aiGenerationId: 0,
  aiAbortController: null,
  aiRequestId: null,
  generatedAiUrl: ""
};

const languages = {
  "en-US": { name: "English", phrases: name => [`Hi! It's ${name}. I'm glad we can share this moment.`, "Let's take a slow breath and enjoy a quiet moment.", "Sending you a big warm hug today!"] },
  "es-ES": { name: "Spanish", phrases: name => [`¡Hola! Soy ${name}. Me alegra compartir este momento contigo.`, "Respiremos despacio y disfrutemos de un momento tranquilo.", "Te mando un abrazo muy grande hoy."] },
  "fr-FR": { name: "French", phrases: name => [`Bonjour ! C'est ${name}. Je suis heureux de partager ce moment avec toi.`, "Prenons une grande respiration et profitons d'un moment paisible.", "Je t'envoie un gros câlin aujourd'hui."] },
  "de-DE": { name: "German", phrases: name => [`Hallo! Hier ist ${name}. Schön, diesen Moment mit dir zu teilen.`, "Atmen wir langsam und genießen einen ruhigen Moment.", "Ich schicke dir heute eine ganz große Umarmung."] },
  "tl-PH": { name: "Tagalog", phrases: name => [`Kumusta! Ako si ${name}. Natutuwa akong magkasama tayo sa sandaling ito.`, "Huminga tayo nang dahan-dahan at magpahinga sandali.", "Nagpapadala ako ng malaking yakap para sa iyo ngayon."] },
  "zh-CN": { name: "Chinese", phrases: name => [`你好！我是${name}。很高兴和你一起度过这段时光。`, "让我们慢慢深呼吸，享受片刻宁静。", "今天送给你一个大大的拥抱。"] },
  "hi-IN": { name: "Hindi", phrases: name => [`नमस्ते! मैं ${name} हूँ। मुझे यह पल आपके साथ बिताकर खुशी हो रही है।`, "आइए धीरे-धीरे सांस लें और कुछ पल शांति से बिताएँ।", "आज मैं आपको एक बड़ी सी झप्पी भेज रहा हूँ।"] },
  "it-IT": { name: "Italian", phrases: name => [`Ciao! Sono ${name}. Sono felice di condividere questo momento con te.`, "Facciamo un respiro profondo e godiamoci un momento tranquillo.", "Ti mando un grande abbraccio oggi."] },
  "ja-JP": { name: "Japanese", phrases: name => [`こんにちは、${name}です。この時間を一緒に過ごせてうれしいです。`, "ゆっくり深呼吸して、穏やかな時間を過ごしましょう。", "今日は大きなハグを送ります。"] }
};

const AI_MODEL_LANGUAGES = {
  "en-US": "english",
  "es-ES": "spanish",
  "fr-FR": "french",
  "de-DE": "german",
  "zh-CN": "chinese",
  "it-IT": "italian",
  "ja-JP": "japanese"
};

function $(id) { return document.getElementById(id); }

function safeRead(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch (error) {
    console.warn(`Could not read ${key}:`, error);
    return fallback;
  }
}

function saveProfiles() {
  try {
    localStorage.setItem("echoProfiles", JSON.stringify(state.profiles));
    return true;
  } catch (error) {
    console.warn("Could not save profiles:", error);
    return false;
  }
}

function openVoiceClipDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("This browser does not support local audio storage."));
  if (!voiceClipDbPromise) {
    voiceClipDbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = window.indexedDB.open("echo-voice-clips", 1);
      } catch (error) {
        voiceClipDbPromise = null;
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("voice-clips")) db.createObjectStore("voice-clips", { keyPath: "profileId" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => {
        voiceClipDbPromise = null;
        reject(request.error || new Error("Could not open local voice storage."));
      };
      request.onblocked = () => {
        voiceClipDbPromise = null;
        reject(new Error("Local voice storage is blocked by another tab. Close other Echo tabs and try again."));
      };
    });
  }
  return voiceClipDbPromise;
}

async function storeVoiceClip(profileId, blob) {
  const db = await openVoiceClipDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("voice-clips", "readwrite");
    transaction.objectStore("voice-clips").put({ profileId, blob, mimeType: blob.type, recordedAt: Date.now() });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not save the local recording."));
    transaction.onabort = () => reject(transaction.error || new Error("Saving the local recording was cancelled."));
  });
}

async function loadVoiceClip(profileId) {
  const db = await openVoiceClipDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("voice-clips", "readonly").objectStore("voice-clips").get(profileId);
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => reject(request.error || new Error("Could not read the local recording."));
  });
}

async function deleteVoiceClip(profileId) {
  const db = await openVoiceClipDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("voice-clips", "readwrite");
    transaction.objectStore("voice-clips").delete(profileId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not delete the local recording."));
    transaction.onabort = () => reject(transaction.error || new Error("Deleting the local recording was cancelled."));
  });
}

function getDefaultPhrases(name) {
  return Object.fromEntries(Object.entries(languages).map(([code, item]) => [code, item.phrases(name || "your loved one")]));
}

function loadVoices() {
  if (!("speechSynthesis" in window)) {
    const note = $("voice-help");
    if (note) note.textContent = "Text-to-speech is not available in this browser. Try a current browser with system speech voices enabled.";
    return;
  }
  state.voices = window.speechSynthesis.getVoices() || [];
  ["voice-select", "profile-voice-select"].forEach(id => {
    const selector = $(id);
    if (!selector) return;
    const previous = id === "voice-select" ? (state.selectedVoiceURI || selector.value) : selector.value;
    selector.replaceChildren(new Option(id === "profile-voice-select" ? "Automatic — use Settings voice" : "Automatic — match spoken language", ""));
    state.voices.slice().sort((a, b) => `${a.lang} ${a.name}`.localeCompare(`${b.lang} ${b.name}`)).forEach(voice => {
      selector.add(new Option(`${voice.name} — ${voice.lang}${voice.default ? " (system default)" : ""}`, voice.voiceURI));
    });
    if (previous && !state.voices.some(voice => voice.voiceURI === previous)) {
      const label = state.voices.length ? "Saved voice unavailable — using language match" : "Saved voice still loading — using language match";
      selector.add(new Option(label, previous));
    }
    selector.value = previous || "";
  });
  const note = $("voice-help");
  if (note) note.textContent = state.voices.length
    ? `${state.voices.length} browser voice${state.voices.length === 1 ? "" : "s"} available. Select one to test it or assign it to a family profile.`
    : "No browser voices are available yet. Install a text-to-speech voice on your device, then refresh this list.";
}

function getBestVoice(languageCode) {
  const voices = state.voices.length ? state.voices : (window.speechSynthesis?.getVoices() || []);
  if (!voices.length) return null;
  const language = String(languageCode || state.currentLang).toLowerCase();
  const base = language.split("-")[0];
  return voices.find(v => v.lang?.toLowerCase() === language) || voices.find(v => v.lang?.toLowerCase().startsWith(base + "-")) || voices.find(v => v.lang?.toLowerCase().startsWith(base)) || null;
}

function voiceMatchesLanguage(voice, languageCode) {
  const voiceLanguage = String(voice?.lang || "").toLowerCase();
  const requestedLanguage = String(languageCode || state.currentLang).toLowerCase();
  const baseLanguage = requestedLanguage.split("-")[0];
  return voiceLanguage === requestedLanguage || voiceLanguage === baseLanguage || voiceLanguage.startsWith(`${baseLanguage}-`);
}

function selectedVoice(voiceURI = "", languageCode = state.currentLang) {
  const preferredURI = voiceURI || state.selectedVoiceURI;
  const preferred = preferredURI ? state.voices.find(v => v.voiceURI === preferredURI) : null;
  if (preferred && voiceMatchesLanguage(preferred, languageCode)) return preferred;
  return getBestVoice(languageCode);
}

function speakText(text, pitch = 1, rate = 0.85, voiceURI = "", languageCode = state.currentLang) {
  if (!("speechSynthesis" in window)) { alert("Speech playback is not supported by this browser."); return; }
  if (!text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.pitch = Math.max(0.5, Math.min(2, Number(pitch) || 1));
  utterance.rate = Math.max(0.5, Math.min(1.5, Number(rate) || 0.85));
  const utteranceLanguage = String(languageCode || state.currentLang);
  const voice = selectedVoice(voiceURI, utteranceLanguage);
  if (voice) utterance.voice = voice;
  utterance.lang = utteranceLanguage;
  const modal = $("call-modal");
  utterance.onstart = () => modal?.classList.add("speaking");
  utterance.onend = utterance.onerror = () => modal?.classList.remove("speaking");
  window.speechSynthesis.speak(utterance);
}

function changeLanguage(code) {
  if (!languages[code]) return;
  state.currentLang = code;
  try { localStorage.setItem("echoLang", code); } catch (_) {}
  const select = $("lang-select");
  if (select) select.value = code;
  if (state.recognition) state.recognition.lang = code;
  if (!state.selectedVoiceURI) loadVoices();
  clearGeneratedAiAudio();
  updateAiControls();
  updateDateTime();
  if (state.activePerson) speakRandomPhrase();
}

function updateDateTime() {
  const now = new Date();
  if ($("landing-time")) $("landing-time").textContent = now.toLocaleTimeString(state.currentLang, { hour: "2-digit", minute: "2-digit" });
  if ($("landing-date")) $("landing-date").textContent = now.toLocaleDateString(state.currentLang, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function openMainApp() {
  $("welcome-screen")?.classList.remove("active");
  $("app-shell")?.classList.add("active");
  renderProfiles();
}

function showWelcomeScreen() {
  cancelUnfinishedRecording("Recording stopped and any unsaved take was discarded because you left Echo.");
  clearGeneratedAiAudio();
  stopProfileAudioPlayers();
  closeCall();
  $("app-shell")?.classList.remove("active");
  $("welcome-screen")?.classList.add("active");
}

function switchTab(tab) {
  if (tab !== "voice-studio" && $("tab-voice-studio")?.classList.contains("active")) {
    cancelUnfinishedRecording("Recording stopped and any unsaved take was discarded because you left Voice Studio.");
    clearGeneratedAiAudio();
  }
  if (tab !== "loved-ones") stopProfileAudioPlayers();
  document.querySelectorAll(".tab-content").forEach(el => el.classList.toggle("active", el.id === `tab-${tab}`));
  document.querySelectorAll(".nav-btn").forEach(el => el.classList.toggle("active", el.id === `nav-${tab}`));
}

function releaseProfileAudioUrls() {
  state.profileAudioUrls.forEach(url => URL.revokeObjectURL(url));
  state.profileAudioUrls.clear();
}

function stopProfileAudioPlayers() {
  document.querySelectorAll(".profile-recording-player").forEach(player => player.pause());
}

async function attachProfileAudio(profile, audio, status) {
  try {
    const blob = await loadVoiceClip(profile.id);
    if (!blob) {
      status.textContent = "Saved clip is missing from this browser. Record a new one in Voice Studio.";
      audio.remove();
      return;
    }
    const url = URL.createObjectURL(blob);
    state.profileAudioUrls.set(audio, url);
    audio.src = url;
  } catch (error) {
    console.warn("Could not load the local voice recording:", error);
    status.textContent = "Could not read this local recording. Check this browser's storage settings.";
    audio.remove();
  }
}

function renderProfiles() {
  const list = $("loved-ones-list");
  if (!list) return;
  releaseProfileAudioUrls();
  list.replaceChildren();
  if (!state.profiles.length) {
    const empty = document.createElement("p");
    empty.className = "empty-profiles";
    empty.textContent = "No family profiles yet. Add a name in Voice Studio to get started.";
    list.append(empty);
    return;
  }
  state.profiles.forEach(profile => {
    const card = document.createElement("article");
    card.className = "person-card";
    const header = document.createElement("div");
    header.className = "person-card-header";
    const avatar = document.createElement("div");
    avatar.className = "avatar-circle";
    avatar.textContent = (profile.name || "?").trim().charAt(0).toUpperCase();
    const info = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = profile.name;
    const relation = document.createElement("p");
    relation.textContent = profile.relation || "Family member";
    info.append(name, relation);
    header.append(avatar, info);

    if (profile.voiceClipSaved) {
      const clipPanel = document.createElement("div");
      clipPanel.className = "profile-recording-panel";
      const clipLabel = document.createElement("p");
      clipLabel.textContent = "Original voice recording · saved only in this browser";
      const audio = document.createElement("audio");
      audio.className = "profile-recording-player";
      audio.controls = true;
      audio.preload = "none";
      audio.setAttribute("aria-label", `Replay ${profile.name}'s local voice recording`);
      const clipStatus = document.createElement("p");
      clipStatus.className = "profile-recording-status";
      clipStatus.setAttribute("role", "status");
      clipStatus.textContent = "Loading local recording…";
      audio.addEventListener("play", () => {
        document.querySelectorAll(".profile-recording-player").forEach(other => { if (other !== audio) other.pause(); });
      });
      clipPanel.append(clipLabel, audio, clipStatus);
      card.append(header, clipPanel);
      attachProfileAudio(profile, audio, clipStatus);
    } else {
      card.append(header);
    }

    const actions = document.createElement("div");
    actions.className = "person-card-actions";
    const call = document.createElement("button");
    call.className = "btn-call-now";
    call.type = "button";
    call.setAttribute("aria-label", `Speak a sample phrase for ${profile.name} using a browser voice`);
    call.innerHTML = '<i class="fa-solid fa-volume-high"></i> Speak sample phrase';
    call.addEventListener("click", () => openPerson(profile));
    const edit = document.createElement("button");
    edit.className = "btn-profile-edit";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit ${profile.name}'s voice profile`);
    edit.addEventListener("click", () => editProfile(profile.id));
    const remove = document.createElement("button");
    remove.className = "btn-profile-delete";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${profile.name}'s voice profile and its local clip`);
    remove.addEventListener("click", () => deleteProfile(profile.id));
    actions.append(call, edit, remove);
    card.append(actions);
    list.append(card);
  });
}

async function editProfile(id) {
  const profile = state.profiles.find(item => item.id === id);
  if (!profile) return;
  state.editingProfileId = profile.id;
  state.pendingVoiceClip = null;
  state.existingVoiceClip = null;
  clearGeneratedAiAudio();
  clearAudioPreview();
  $("profile-name").value = profile.name || "";
  $("profile-relation").value = profile.relation || "";
  $("voice-clip-transcript").value = profile.voiceClipTranscript || "";
  $("voice-pitch").value = String(profile.pitch || 1);
  $("voice-rate").value = String(profile.rate || 0.85);
  const profileVoiceSelector = $("profile-voice-select");
  const profileVoiceURI = profile.voiceURI || "";
  if (profileVoiceSelector && profileVoiceURI && !Array.from(profileVoiceSelector.options).some(option => option.value === profileVoiceURI)) {
    const label = state.voices.length ? "Saved voice unavailable — using language match" : "Saved voice still loading — using language match";
    profileVoiceSelector.add(new Option(label, profileVoiceURI));
  }
  if (profileVoiceSelector) profileVoiceSelector.value = profileVoiceURI;
  $("voice-consent").checked = false;
  $("ai-voice-consent").checked = false;
  $("ai-voice-text").value = "";
  $("remove-saved-clip").checked = false;
  $("remove-saved-clip-row").classList.toggle("hidden", !profile.voiceClipSaved);
  $("btn-save-profile").innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Changes';
  $("btn-cancel-profile-edit")?.classList.remove("hidden");
  $("rec-timer").textContent = "00:00";
  $("rec-status-text").textContent = profile.voiceClipSaved ? "Existing local recording is available below." : "No local recording saved for this profile yet.";
  updateTuningLabels();
  updateRecordingUI(false);
  updateAiControls();
  switchTab("voice-studio");
  $("profile-name").focus();
  if (profile.voiceClipSaved) {
    try {
      const blob = await loadVoiceClip(profile.id);
      if (state.editingProfileId !== id) return;
      if (blob) {
        state.existingVoiceClip = blob;
        setAudioPreview(blob, false);
      } else {
        profile.voiceClipSaved = false;
        profile.voiceClipTranscript = "";
        saveProfiles();
        $("voice-clip-transcript").value = "";
        $("remove-saved-clip-row").classList.add("hidden");
        $("rec-status-text").textContent = "No recording is stored in this browser. You can record a new local clip.";
      }
    } catch (error) {
      console.warn("Could not open this local clip:", error);
      $("rec-status-text").textContent = "Could not read local audio storage. Check browser storage settings and try again.";
    }
  }
}

function cancelUnfinishedRecording(message) {
  let cancelled = false;
  if (state.preparingRecording) {
    state.recordingAttempt += 1;
    state.preparingRecording = false;
    cancelled = true;
  }
  if (state.clipRecording) {
    state.discardNextRecorderStop = true;
    stopVoiceRecording();
    cancelled = true;
  }
  if (state.recordingTimer) window.clearInterval(state.recordingTimer);
  state.recordingTimer = null;
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }
  if (state.pendingVoiceClip) {
    state.pendingVoiceClip = null;
    if (state.existingVoiceClip && !$("remove-saved-clip")?.checked) setAudioPreview(state.existingVoiceClip, false);
    else clearAudioPreview();
    cancelled = true;
  }
  if (cancelled && $("rec-status-text")) $("rec-status-text").textContent = message;
  updateRecordingUI(state.clipRecording);
  updateAiControls();
  return cancelled;
}

function handleRecordingConsentChange() {
  if ($("voice-consent")?.checked) {
    updateRecordingUI(state.clipRecording);
    updateAiControls();
    return;
  }
  $("ai-voice-consent").checked = false;
  clearGeneratedAiAudio();
  cancelUnfinishedRecording("Recording stopped and any unsaved take was discarded because speaker confirmation was withdrawn.");
}

function resetProfileForm() {
  cancelUnfinishedRecording("Recording cancelled because the profile editor was closed.");
  state.editingProfileId = null;
  state.pendingVoiceClip = null;
  state.existingVoiceClip = null;
  clearGeneratedAiAudio();
  $("profile-name").value = "";
  $("profile-relation").value = "";
  $("voice-clip-transcript").value = "";
  $("ai-voice-text").value = "";
  $("profile-voice-select").value = "";
  $("voice-pitch").value = "1";
  $("voice-rate").value = "0.85";
  $("voice-consent").checked = false;
  $("ai-voice-consent").checked = false;
  $("remove-saved-clip").checked = false;
  $("remove-saved-clip-row").classList.add("hidden");
  $("btn-save-profile").innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Profile';
  $("btn-cancel-profile-edit")?.classList.add("hidden");
  $("rec-status-text").textContent = `Record a clip of up to ${MAX_CLIP_SECONDS} seconds for replay in this browser.`;
  $("rec-timer").textContent = "00:00";
  $("ai-generation-status").textContent = "Save a voice sample and its exact transcript to enable generation.";
  clearAudioPreview();
  updateTuningLabels();
  updateRecordingUI(false);
  updateAiControls();
}

async function deleteProfile(id) {
  const profile = state.profiles.find(item => item.id === id);
  if (!profile || !window.confirm(`Delete the voice profile for ${profile.name} and its saved local recording?`)) return;
  const previousProfiles = state.profiles.slice();
  state.profiles = state.profiles.filter(item => item.id !== id);
  if (!saveProfiles()) {
    state.profiles = previousProfiles;
    alert("The profile could not be deleted because this browser could not save the change.");
    return;
  }
  try {
    if (profile.voiceClipSaved) await deleteVoiceClip(profile.id);
  } catch (error) {
    state.profiles = previousProfiles;
    saveProfiles();
    alert("The profile was kept because its local recording could not be removed. Check browser storage and try again.");
    return;
  }
  if (state.activePerson?.id === id) closeCall();
  renderProfiles();
}

function openPerson(profile) {
  if (!profile) return;
  state.activePerson = profile;
  $("call-name").textContent = profile.name || "Your loved one";
  $("call-relation").textContent = profile.relation || "Family member";
  $("call-avatar").textContent = (profile.name || "?").trim().charAt(0).toUpperCase();
  $("call-modal")?.classList.add("active");
  speakRandomPhrase();
}

function speakRandomPhrase() {
  const profile = state.activePerson;
  if (!profile) return;
  const phrases = languages[state.currentLang]?.phrases(profile.name) || getDefaultPhrases(profile.name)[state.currentLang];
  const phrase = phrases[Math.floor(Math.random() * phrases.length)];
  if ($("call-speech-text")) $("call-speech-text").textContent = `“${phrase}”`;
  speakText(phrase, profile.pitch, profile.rate, profile.voiceURI, state.currentLang);
}

function closeCall() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  if (state.recognition && state.recognitionActive) { try { state.recognition.stop(); } catch (_) {} }
  state.activePerson = null;
  $("call-modal")?.classList.remove("active", "speaking");
}

function endVoiceCall() { closeCall(); }

function createRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.lang = state.currentLang;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.onstart = () => {
    state.recognitionActive = true;
    const label = $("mic-btn-label");
    if (label) label.textContent = "Listening… tap to stop";
  };
  recognition.onend = () => {
    state.recognitionActive = false;
    const label = $("mic-btn-label");
    if (label) label.textContent = "Tap to Speak";
  };
  recognition.onerror = event => {
    state.recognitionActive = false;
    console.warn("Speech recognition:", event.error);
    if ($("call-speech-text")) $("call-speech-text").textContent = event.error === "not-allowed"
      ? "Microphone permission was declined. Allow access in your browser settings and try again."
      : "Speech recognition stopped or is unavailable. You can still play sample phrases.";
  };
  recognition.onresult = event => {
    const text = event.results?.[0]?.[0]?.transcript;
    if (text && $("call-speech-text")) $("call-speech-text").textContent = `You said: “${text}”`;
  };
  return recognition;
}

function handleMicTalkTap() {
  if (!state.recognition) state.recognition = createRecognition();
  if (!state.recognition) { alert("Speech recognition is not available in this browser. Try Chrome or Edge and allow microphone access."); return; }
  if (state.recognitionActive) { state.recognition.stop(); return; }
  state.recognition.lang = state.currentLang;
  try { state.recognition.start(); } catch (error) { console.warn("Could not start recognition:", error); }
}

function formatRecordingTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remaining = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function updateRecordingUI(isRecording = state.clipRecording) {
  const start = $("btn-record");
  const stop = $("btn-stop-rec");
  const consent = $("voice-consent");
  const removeSaved = $("remove-saved-clip");
  if (start) start.disabled = isRecording || state.preparingRecording || !consent?.checked;
  if (stop) stop.disabled = !isRecording;
  if (removeSaved) removeSaved.disabled = isRecording || state.preparingRecording || Boolean(state.pendingVoiceClip);
}

function clearAudioPreview() {
  const audio = $("audio-playback");
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = "";
  $("audio-preview-container")?.classList.add("hidden");
  $("btn-discard-pending-clip")?.classList.add("hidden");
}

function setAudioPreview(blob, isPending) {
  clearAudioPreview();
  state.previewUrl = URL.createObjectURL(blob);
  const audio = $("audio-playback");
  if (audio) audio.src = state.previewUrl;
  const label = $("audio-preview-label");
  if (label) label.textContent = isPending ? "New take — not saved until you save the profile" : "Saved original recording — local to this browser";
  const note = $("audio-preview-note");
  if (note) note.textContent = "This player replays the original recording. Sample phrases still use the selected browser/device voice.";
  $("audio-preview-container")?.classList.remove("hidden");
  $("btn-discard-pending-clip")?.classList.toggle("hidden", !isPending);
  updateRecordingUI(state.clipRecording);
  updateAiControls();
}

function discardPendingVoiceClip() {
  if (!state.pendingVoiceClip) return;
  state.pendingVoiceClip = null;
  if (state.existingVoiceClip && !$("remove-saved-clip").checked) setAudioPreview(state.existingVoiceClip, false);
  else clearAudioPreview();
  $("rec-status-text").textContent = "New take discarded. The existing saved clip is unchanged until you save.";
  updateRecordingUI(false);
  updateAiControls();
}

function handleSavedClipRemovalChange() {
  const status = $("rec-status-text");
  if ($("remove-saved-clip").checked) {
    clearGeneratedAiAudio();
    if (status) status.textContent = "The existing local recording will be removed when you save this profile.";
  } else if (status) {
    status.textContent = "The existing recording will be kept unless you record a replacement.";
  }
  updateAiControls();
}

function stopVoiceRecording() {
  const recorder = state.mediaRecorder;
  if (recorder && recorder.state !== "inactive") {
    try { recorder.stop(); } catch (error) { console.warn("Could not stop the voice clip recorder:", error); }
  }
}

async function startVoiceClipRecording() {
  if (!$("voice-consent")?.checked) {
    $("rec-status-text").textContent = "Please confirm the speaker has agreed before recording.";
    $("voice-consent")?.focus();
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $("rec-status-text").textContent = "Recording is unavailable here. Use a current browser on this HTTPS site or localhost, then allow microphone access.";
    return;
  }
  clearGeneratedAiAudio();
  const attempt = ++state.recordingAttempt;
  state.preparingRecording = true;
  updateRecordingUI(false);
  updateAiControls();
  try {
    $("rec-status-text").textContent = "Preparing private, local storage…";
    await openVoiceClipDb();
    if (attempt !== state.recordingAttempt) return;
    if (!$("voice-consent")?.checked) {
      state.preparingRecording = false;
      updateRecordingUI(false);
      $("rec-status-text").textContent = "Recording cancelled because speaker confirmation was withdrawn.";
      return;
    }
    $("rec-status-text").textContent = "Waiting for microphone permission…";
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (attempt !== state.recordingAttempt || !$("voice-consent")?.checked) {
      stream.getTracks().forEach(track => track.stop());
      if (attempt === state.recordingAttempt) {
        state.preparingRecording = false;
        updateRecordingUI(false);
        $("rec-status-text").textContent = "Recording cancelled because speaker confirmation was withdrawn.";
      }
      return;
    }
    state.mediaStream = stream;
    const mimeTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    const mimeType = mimeTypes.find(type => window.MediaRecorder.isTypeSupported?.(type));
    const recorder = mimeType ? new window.MediaRecorder(state.mediaStream, { mimeType }) : new window.MediaRecorder(state.mediaStream);
    state.mediaRecorder = recorder;
    state.audioChunks = [];
    state.discardNextRecorderStop = false;
    recorder.ondataavailable = event => { if (event.data?.size) state.audioChunks.push(event.data); };
    recorder.onerror = event => {
      console.warn("Voice recording error:", event.error || event);
      state.discardNextRecorderStop = true;
      $("rec-status-text").textContent = "The recording stopped because the browser reported an audio error. Please try again.";
      stopVoiceRecording();
    };
    recorder.onstop = () => {
      const chunks = state.audioChunks.splice(0);
      const clip = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" });
      const discard = state.discardNextRecorderStop;
      state.discardNextRecorderStop = false;
      state.clipRecording = false;
      if (state.recordingTimer) window.clearInterval(state.recordingTimer);
      state.recordingTimer = null;
      state.mediaStream?.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
      state.mediaRecorder = null;
      updateRecordingUI(false);
      if (discard) return;
      if (clip.size < 256) {
        $("rec-status-text").textContent = "No usable audio was captured. Check microphone permission and try again.";
        return;
      }
      if (clip.size > MAX_CLIP_BYTES) {
        $("rec-status-text").textContent = "This clip is larger than the 5 MB local limit. Record a shorter clip and try again.";
        return;
      }
      state.pendingVoiceClip = clip;
      $("remove-saved-clip").checked = false;
      $("voice-clip-transcript").value = "";
      setAudioPreview(clip, true);
      $("rec-status-text").textContent = "Recording ready. Type the exact words, then save this profile before local AI generation.";
      updateRecordingUI(false);
      updateAiControls();
    };
    if (attempt !== state.recordingAttempt || !$("voice-consent")?.checked) {
      state.preparingRecording = false;
      state.mediaStream?.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
      state.mediaRecorder = null;
      updateRecordingUI(false);
      if (attempt === state.recordingAttempt) $("rec-status-text").textContent = "Recording cancelled because speaker confirmation was withdrawn.";
      return;
    }
    state.clipRecording = true;
    state.preparingRecording = false;
    state.recordingStartedAt = Date.now();
    $("rec-timer").textContent = "00:00";
    recorder.start(250);
    updateRecordingUI(true);
    updateAiControls();
    $("rec-status-text").textContent = `Recording… up to ${MAX_CLIP_SECONDS} seconds. Press Stop when finished.`;
    state.recordingTimer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
      $("rec-timer").textContent = formatRecordingTime(elapsed);
      if (elapsed >= MAX_CLIP_SECONDS) {
        $("rec-status-text").textContent = "The 30-second recording limit was reached. Preparing your local preview…";
        stopVoiceRecording();
      }
    }, 200);
  } catch (error) {
    console.warn("Could not start local voice recording:", error);
    if (attempt !== state.recordingAttempt) return;
    state.clipRecording = false;
    state.preparingRecording = false;
    state.mediaStream?.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
    state.mediaRecorder = null;
    if (state.recordingTimer) window.clearInterval(state.recordingTimer);
    state.recordingTimer = null;
    updateRecordingUI(false);
    updateAiControls();
    $("rec-status-text").textContent = error?.name === "NotAllowedError"
      ? "Microphone access was declined. Allow it in your browser settings to record a local clip."
      : `Could not start recording: ${error?.message || "check microphone access and browser storage settings"}`;
  }
}

function toggleHighContrast() {
  document.body.classList.toggle("high-contrast");
  const enabled = document.body.classList.contains("high-contrast");
  [$("btn-high-contrast"), $("btn-high-contrast-settings")].forEach(button => button?.setAttribute("aria-pressed", String(enabled)));
  try { localStorage.setItem("echoHighContrast", enabled ? "1" : "0"); } catch (_) {}
}

function setFontSize(size) {
  document.body.classList.remove("font-large", "font-xlarge");
  if (size === "large") document.body.classList.add("font-large");
  if (size === "xlarge") document.body.classList.add("font-xlarge");
  try { localStorage.setItem("echoFontSize", size); } catch (_) {}
}

function toggleMed(which) {
  const box = $(`med-${which}`);
  try { if (box) localStorage.setItem(`echoMed-${which}`, box.checked ? "1" : "0"); } catch (_) {}
}

function updateTuningLabels() {
  if ($("pitch-val")) $("pitch-val").textContent = Number($("voice-pitch").value).toFixed(1);
  if ($("rate-val")) $("rate-val").textContent = Number($("voice-rate").value).toFixed(2);
}

function voiceSample(languageCode) {
  const base = String(languageCode || state.currentLang).toLowerCase().split("-")[0];
  const samples = {
    en: "Hello. This is a sample of the selected voice.", es: "Hola. Esta es una muestra de la voz seleccionada.",
    fr: "Bonjour. Ceci est un exemple de la voix sélectionnée.", de: "Hallo. Dies ist eine Hörprobe der ausgewählten Stimme.",
    tl: "Kamusta. Ito ay pagsubok ng napiling boses.", zh: "你好，这是所选语音的试听。", hi: "नमस्ते, यह चुनी हुई आवाज़ का नमूना है।",
    it: "Ciao. Questa è un'anteprima della voce selezionata.", ja: "こんにちは。選択した音声のサンプルです。", pt: "Olá. Esta é uma amostra da voz selecionada.",
    ko: "안녕하세요. 선택한 음성의 미리 듣기입니다.", ru: "Здравствуйте. Это образец выбранного голоса."
  };
  return samples[base] || samples.en;
}

function scheduleVoiceDiscovery() {
  [200, 500, 1000, 2000, 4000].forEach(delay => window.setTimeout(loadVoices, delay));
}

function refreshVoiceList() {
  loadVoices();
  if (!state.voices.length) {
    const note = $("voice-help");
    if (note) note.textContent = "Checking with the browser for installed voices…";
  }
  scheduleVoiceDiscovery();
}

function previewSelectedVoice() {
  const voice = state.voices.find(item => item.voiceURI === state.selectedVoiceURI) || getBestVoice(state.currentLang);
  const language = voice?.lang || state.currentLang;
  speakText(voiceSample(language), 1, 0.9, voice?.voiceURI || "", language);
}

function previewProfileVoice() {
  const voiceURI = $("profile-voice-select")?.value || "";
  const voice = (voiceURI && state.voices.find(item => item.voiceURI === voiceURI)) || selectedVoice(voiceURI, state.currentLang);
  const language = voice?.lang || state.currentLang;
  speakText(voiceSample(language), 1, 0.9, voice?.voiceURI || voiceURI, language);
}

function isLocalEchoOrigin() {
  return window.location.protocol === "http:" && ["localhost", "127.0.0.1"].includes(window.location.hostname.toLowerCase());
}

function setLocalAiStatus(message, stateName = "info") {
  const status = $("local-ai-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = stateName;
}

function setAiGenerationStatus(message, stateName = "info") {
  const status = $("ai-generation-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = stateName;
}

function clearGeneratedAiAudio() {
  const requestId = state.aiRequestId;
  if (requestId && isLocalEchoOrigin()) {
    try {
      fetch("/api/voice/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
        keepalive: true
      }).catch(() => {});
    } catch (_) {}
  }
  state.aiRequestId = null;
  state.aiGenerationId += 1;
  state.aiAbortController?.abort();
  state.aiAbortController = null;
  state.generatingLocalAi = false;
  if ($("ai-voice-consent")) $("ai-voice-consent").checked = false;
  $("btn-cancel-ai-generation")?.classList.add("hidden");
  const audio = $("ai-generated-audio");
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  const link = $("btn-download-ai-voice");
  if (link) link.removeAttribute("href");
  if (state.generatedAiUrl) URL.revokeObjectURL(state.generatedAiUrl);
  state.generatedAiUrl = "";
  $("ai-voice-output")?.classList.add("hidden");
}

function cancelLocalAiGeneration() {
  if (!state.generatingLocalAi) return;
  clearGeneratedAiAudio();
  updateAiControls();
  setAiGenerationStatus("Canceled. If model inference had already started, it continues locally on this Mac until it finishes; temporary files and reference cache are then cleared.", "info");
}

async function checkLocalAiStatus() {
  if (state.localAiChecking) return;
  if (!isLocalEchoOrigin()) {
    state.localAiAvailable = false;
    $("local-ai-request-controls")?.classList.add("hidden");
    $("local-ai-download-link")?.classList.remove("hidden");
    setLocalAiStatus("Local AI voice generation is disabled on the public website. Run this VS Code project on this Mac to use its on-device model.", "error");
    updateAiControls();
    return;
  }
  $("local-ai-request-controls")?.classList.remove("hidden");
  $("local-ai-download-link")?.classList.add("hidden");
  state.localAiChecking = true;
  setLocalAiStatus("Checking the local Mac voice model…");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const result = await response.json();
    state.localAiAvailable = response.ok && result.available === true;
    setLocalAiStatus(result.message || (state.localAiAvailable ? "Local model is ready." : "Local model is not available."), state.localAiAvailable ? "ready" : "error");
  } catch (_) {
    state.localAiAvailable = false;
    setLocalAiStatus("Local Echo server not found. Start it with ./run.sh in the VS Code terminal; install the model packages first with ./setup-local-ai.sh.", "error");
  } finally {
    state.localAiChecking = false;
    updateAiControls();
  }
}

function updateAiControls() {
  const button = $("btn-generate-ai-voice");
  if (!button) return;
  const profile = state.profiles.find(item => item.id === state.editingProfileId);
  const clipAvailable = Boolean(profile?.voiceClipSaved && !state.pendingVoiceClip && !$("remove-saved-clip")?.checked);
  const transcript = $("voice-clip-transcript")?.value.trim() || "";
  const savedTranscript = profile?.voiceClipTranscript?.trim() || "";
  const transcriptMatchesSaved = Boolean(savedTranscript && transcript === savedTranscript);
  const text = $("ai-voice-text")?.value.trim() || "";
  const consent = Boolean($("ai-voice-consent")?.checked);
  const languageName = AI_MODEL_LANGUAGES[state.currentLang];
  const isBusy = state.generatingLocalAi || state.clipRecording || state.preparingRecording || state.savingProfile;
  button.disabled = isBusy || !state.localAiAvailable || !clipAvailable || !transcriptMatchesSaved || !text || !consent || !languageName;
  if ($("ai-voice-consent")) $("ai-voice-consent").disabled = isBusy;
  $("btn-cancel-ai-generation")?.classList.toggle("hidden", !state.generatingLocalAi);

  const languageNote = $("ai-language-note");
  if (languageNote) {
    languageNote.textContent = languageName
      ? `Generated speech language: ${languages[state.currentLang]?.name || languageName}. This does not change your browser voice settings.`
      : `${languages[state.currentLang]?.name || "This language"} is not supported by the local model. Choose English, Spanish, French, German, Chinese, Italian, or Japanese.`;
  }

  if (state.generatingLocalAi || state.generatedAiUrl) return;
  if (!state.localAiAvailable) setAiGenerationStatus("Start the local Mac server and make sure the model is available before generating.");
  else if (!languageName) setAiGenerationStatus("Choose a language supported by this local model.");
  else if (!profile || !clipAvailable) setAiGenerationStatus("Save a profile with a recorded voice sample before generating.");
  else if (!transcript) setAiGenerationStatus("Type and save the exact words spoken in the recording.");
  else if (!transcriptMatchesSaved) setAiGenerationStatus("Save this transcript with the voice profile before generating.");
  else if (!text) setAiGenerationStatus("Enter the sentence you want the recorded voice to say.");
  else if (!consent) setAiGenerationStatus("Read and check the speaker-permission box before generation.");
  else setAiGenerationStatus("Ready. The sample and text will be sent only to this Mac's local Echo process.", "ready");
}

async function blobToWavBase64(blob) {
  if (!blob || blob.size > MAX_CLIP_BYTES) throw new Error("The saved voice sample is empty or exceeds the 5 MB limit.");
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser cannot convert the saved sample for local AI. Try a current version of Safari or Chrome.");
  const context = new AudioContextClass();
  try {
    const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
    const sampleRate = 24000;
    const frameCount = Math.max(1, Math.ceil(audioBuffer.duration * sampleRate));
    const dataBytes = frameCount * 2;
    const wav = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(wav);
    const writeText = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, dataBytes, true);

    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, channel) => audioBuffer.getChannelData(channel));
    const sourceStep = audioBuffer.sampleRate / sampleRate;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const position = frame * sourceStep;
      const left = Math.min(Math.floor(position), audioBuffer.length - 1);
      const right = Math.min(left + 1, audioBuffer.length - 1);
      const fraction = position - left;
      let sample = 0;
      channels.forEach(channel => { sample += channel[left] + (channel[right] - channel[left]) * fraction; });
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      view.setInt16(44 + frame * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    const bytes = new Uint8Array(wav);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
    }
    return btoa(binary);
  } finally {
    if (context.state !== "closed") await context.close().catch(() => {});
  }
}

async function generateLocalAiSpeech() {
  if (state.generatingLocalAi) return;
  const profile = state.profiles.find(item => item.id === state.editingProfileId);
  const savedTranscript = profile?.voiceClipTranscript?.trim() || "";
  const editedTranscript = $("voice-clip-transcript")?.value.trim() || "";
  const transcript = savedTranscript;
  const text = $("ai-voice-text")?.value.trim() || "";
  const language = AI_MODEL_LANGUAGES[state.currentLang];
  if (!$("ai-voice-consent")?.checked) { setAiGenerationStatus("Confirm permission from the speaker before generating.", "error"); return; }
  if (!isLocalEchoOrigin() || !state.localAiAvailable) { await checkLocalAiStatus(); return; }
  if (!profile?.voiceClipSaved || state.pendingVoiceClip || $("remove-saved-clip")?.checked) {
    setAiGenerationStatus("Save an original recording in this profile before generating.", "error");
    return;
  }
  if (!savedTranscript || editedTranscript !== savedTranscript) {
    setAiGenerationStatus("Save the exact transcript with this voice profile before generating.", "error");
    $("voice-clip-transcript")?.focus();
    return;
  }
  if (!transcript) { setAiGenerationStatus("Enter the exact transcript of the saved sample before generating.", "error"); $("voice-clip-transcript")?.focus(); return; }
  if (!text || text.length > 500) { setAiGenerationStatus("Enter a sentence of up to 500 characters.", "error"); $("ai-voice-text")?.focus(); return; }
  if (!language) { setAiGenerationStatus("The local model does not support the selected language.", "error"); return; }

  clearGeneratedAiAudio();
  const generationId = ++state.aiGenerationId;
  const controller = new AbortController();
  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  state.aiAbortController = controller;
  state.aiRequestId = requestId;
  state.generatingLocalAi = true;
  $("ai-voice-consent").checked = false;
  updateAiControls();
  setAiGenerationStatus("Preparing the saved sample on this Mac…");
  try {
    const referenceClip = await loadVoiceClip(profile.id);
    if (!referenceClip) throw new Error("The saved audio is missing from this browser. Record and save a new sample.");
    if (generationId !== state.aiGenerationId) return;
    setAiGenerationStatus("Converting the reference sample locally to 24 kHz WAV…");
    const audioBase64 = await blobToWavBase64(referenceClip);
    if (generationId !== state.aiGenerationId) return;
    setAiGenerationStatus("Generating on this Mac. The first use may take a while while the model downloads its weights…");
    const response = await fetch("/api/voice/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true, requestId, audioBase64, transcript, text, language }),
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Local generation failed (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("audio/wav")) throw new Error("The local server returned an unexpected format instead of WAV audio.");
    const generatedBlob = await response.blob();
    if (generationId !== state.aiGenerationId) return;
    state.aiRequestId = null;
    state.generatedAiUrl = URL.createObjectURL(generatedBlob);
    const audio = $("ai-generated-audio");
    const link = $("btn-download-ai-voice");
    audio.src = state.generatedAiUrl;
    link.href = state.generatedAiUrl;
    $("ai-voice-output")?.classList.remove("hidden");
    setAiGenerationStatus("Finished locally. Press play, or download the WAV before closing the page if you want to keep it.", "ready");
  } catch (error) {
    if (generationId !== state.aiGenerationId) return;
    if (error?.name !== "AbortError") {
      console.warn("Local voice generation failed:", error?.name || "Error");
      setAiGenerationStatus(error?.message || "Local generation failed. Check the server and try again.", "error");
    }
  } finally {
    if (generationId === state.aiGenerationId) {
      state.generatingLocalAi = false;
      state.aiAbortController = null;
      state.aiRequestId = null;
      updateAiControls();
      const status = $("ai-generation-status");
      if (status?.dataset.state === "ready" && $("ai-voice-output")?.classList.contains("hidden")) {
        setAiGenerationStatus("Ready. The sample and text will be sent only to this Mac's local Echo process.", "ready");
      }
    }
  }
}

function initialize() {
  const savedProfiles = safeRead("echoProfiles", []);
  state.profiles = Array.isArray(savedProfiles) ? savedProfiles.map(profile => ({ ...profile, voiceClipSaved: profile.voiceClipSaved === true })) : [];
  const savedLanguage = localStorage.getItem("echoLang");
  state.currentLang = languages[savedLanguage] ? savedLanguage : ($("lang-select")?.value || "en-US");
  if ($("lang-select")) $("lang-select").value = state.currentLang;
  state.selectedVoiceURI = localStorage.getItem("echoVoiceURI") || "";
  if (localStorage.getItem("echoHighContrast") === "1") document.body.classList.add("high-contrast");
  setFontSize(localStorage.getItem("echoFontSize") || "normal");
  ["morning", "afternoon", "evening"].forEach(which => {
    const box = $(`med-${which}`);
    if (box) box.checked = localStorage.getItem(`echoMed-${which}`) === "1";
  });
  $("btn-high-contrast")?.setAttribute("aria-pressed", String(document.body.classList.contains("high-contrast")));
  $("btn-high-contrast-settings")?.setAttribute("aria-pressed", String(document.body.classList.contains("high-contrast")));
  loadVoices();
  if ("speechSynthesis" in window) {
    const synthesis = window.speechSynthesis;
    if (typeof synthesis.addEventListener === "function") synthesis.addEventListener("voiceschanged", loadVoices);
    else synthesis.onvoiceschanged = loadVoices;
    scheduleVoiceDiscovery();
  }
  updateDateTime();
  window.setInterval(updateDateTime, 1000);
  updateTuningLabels();
  updateRecordingUI(false);
  renderProfiles();

  $("btn-enter-app")?.addEventListener("click", openMainApp);
  $("voice-pitch")?.addEventListener("input", updateTuningLabels);
  $("voice-rate")?.addEventListener("input", updateTuningLabels);
  $("voice-select")?.addEventListener("change", event => {
    state.selectedVoiceURI = event.target.value;
    try { localStorage.setItem("echoVoiceURI", state.selectedVoiceURI); } catch (_) {}
  });
  $("btn-test-voice")?.addEventListener("click", previewSelectedVoice);
  $("btn-test-profile-voice")?.addEventListener("click", previewProfileVoice);
  $("btn-refresh-voices")?.addEventListener("click", refreshVoiceList);
  $("lang-select")?.addEventListener("change", event => changeLanguage(event.target.value));
  document.querySelectorAll("[data-action='switch-tab']").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $("btn-record")?.addEventListener("click", startVoiceClipRecording);
  $("btn-stop-rec")?.addEventListener("click", stopVoiceRecording);
  $("voice-consent")?.addEventListener("change", handleRecordingConsentChange);
  $("remove-saved-clip")?.addEventListener("change", handleSavedClipRemovalChange);
  $("voice-clip-transcript")?.addEventListener("input", () => { clearGeneratedAiAudio(); updateAiControls(); });
  $("ai-voice-text")?.addEventListener("input", () => { clearGeneratedAiAudio(); updateAiControls(); });
  $("ai-voice-consent")?.addEventListener("change", () => {
    if (!$("ai-voice-consent")?.checked) clearGeneratedAiAudio();
    updateAiControls();
  });
  $("btn-check-local-ai")?.addEventListener("click", checkLocalAiStatus);
  $("btn-generate-ai-voice")?.addEventListener("click", generateLocalAiSpeech);
  $("btn-cancel-ai-generation")?.addEventListener("click", cancelLocalAiGeneration);
  $("btn-discard-pending-clip")?.addEventListener("click", discardPendingVoiceClip);
  $("btn-save-profile")?.addEventListener("click", saveVoiceProfile);
  $("btn-cancel-profile-edit")?.addEventListener("click", resetProfileForm);
  $("btn-mic-talk")?.addEventListener("click", handleMicTalkTap);
  $("btn-end-call")?.addEventListener("click", endVoiceCall);
  $("btn-high-contrast")?.addEventListener("click", toggleHighContrast);
  $("btn-high-contrast-settings")?.addEventListener("click", toggleHighContrast);
  document.querySelectorAll("[data-font-size]").forEach(button => button.addEventListener("click", () => setFontSize(button.dataset.fontSize)));
  document.querySelectorAll("[data-med]").forEach(box => box.addEventListener("change", () => toggleMed(box.dataset.med)));
  document.querySelector(".header-branding")?.addEventListener("click", showWelcomeScreen);
  window.addEventListener("pagehide", () => {
    cancelUnfinishedRecording("Recording stopped because Echo was closed; unsaved audio was discarded.");
    clearGeneratedAiAudio();
    stopProfileAudioPlayers();
    clearAudioPreview();
    releaseProfileAudioUrls();
  });
  checkLocalAiStatus();
}

async function saveVoiceProfile() {
  if (state.savingProfile) return;
  if (state.clipRecording) { alert("Stop the recording before saving this profile."); return; }
  const name = $("profile-name")?.value.trim();
  const relation = $("profile-relation")?.value.trim();
  if (!name) { alert("Please enter the person's name first."); $("profile-name")?.focus(); return; }

  const existingIndex = state.profiles.findIndex(item => item.id === state.editingProfileId);
  const existing = existingIndex >= 0 ? state.profiles[existingIndex] : null;
  const id = existing?.id || (crypto.randomUUID?.() || String(Date.now()));
  const removeSavedClip = !state.pendingVoiceClip && Boolean(existing?.voiceClipSaved && $("remove-saved-clip")?.checked);
  const hasSavedClip = Boolean(state.pendingVoiceClip) || Boolean(existing?.voiceClipSaved && !removeSavedClip);
  const profile = {
    ...(existing || {}),
    id,
    name,
    relation,
    pitch: Number($("voice-pitch")?.value || 1),
    rate: Number($("voice-rate")?.value || 0.85),
    voiceURI: $("profile-voice-select")?.value || "",
    phrases: getDefaultPhrases(name),
    voiceClipSaved: hasSavedClip,
    voiceClipTranscript: hasSavedClip ? $("voice-clip-transcript")?.value.trim().slice(0, 800) || "" : ""
  };
  const previousProfiles = state.profiles.slice();
  if (existingIndex >= 0) state.profiles[existingIndex] = profile;
  else state.profiles.push(profile);
  if (!saveProfiles()) {
    state.profiles = previousProfiles;
    alert("The profile could not be saved in this browser. Check available local storage and try again.");
    return;
  }

  state.savingProfile = true;
  const saveButton = $("btn-save-profile");
  if (saveButton) saveButton.disabled = true;
  updateAiControls();
  try {
    if (state.pendingVoiceClip) await storeVoiceClip(id, state.pendingVoiceClip);
    else if (removeSavedClip) await deleteVoiceClip(id);
  } catch (error) {
    console.warn("Could not save the profile's local recording:", error);
    state.profiles = previousProfiles;
    saveProfiles();
    if (saveButton) saveButton.disabled = false;
    state.savingProfile = false;
    updateAiControls();
    alert(`The profile change was not saved because local audio storage failed: ${error?.message || "unknown storage error"}`);
    return;
  }
  state.savingProfile = false;
  if (saveButton) saveButton.disabled = false;
  saveProfiles();
  renderProfiles();
  resetProfileForm();
  alert("Profile and reference transcript saved in this browser. Local AI generation is separate from browser/device speech.");
  switchTab("loved-ones");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();

Object.assign(window, {
  openMainApp, showWelcomeScreen, switchTab, changeLanguage, openPerson, editProfile, deleteProfile,
  handleMicTalkTap, endVoiceCall, toggleHighContrast, setFontSize, toggleMed, updateTuningLabels,
  startVoiceClipRecording, stopVoiceRecording, saveVoiceProfile, speakText, previewSelectedVoice,
  previewProfileVoice, refreshVoiceList, renderProfiles, loadVoiceClip, storeVoiceClip, deleteVoiceClip,
  setAudioPreview, clearAudioPreview, discardPendingVoiceClip, checkLocalAiStatus, generateLocalAiSpeech,
  clearGeneratedAiAudio, updateAiControls
});

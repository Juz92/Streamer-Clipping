/**
 * humor-patterns.ts — Detect specific humor structures within a scene.
 *
 * Patterns modeled after professional clip analysis:
 *   1. Setup→Punchline: quiet speech → sudden audio spike + chat eruption
 *   2. Roast pattern: insult phrase + laugh audio + chat "LMAO"
 *   3. Self-deprecation arc: "I" + negative + audience sympathy laugh
 *   4. Callback eruption: chat quiet → single keyword → explosion
 *   5. Crash-out: escalating frustration → peak → silence
 *   6. Visual gag: transcript has visual cue words + chat erupts
 *   7. Reaction chain: streamer action → chat reaction → streamer reaction-to-reaction
 *
 * Each pattern returns a confidence score (0-1) and metadata.
 */

import type { Scene } from "./scene-segmenter.js";
import type { WhisperWord } from "./whisper-captions.js";
import type { ChatMessage } from "./chat-parser.js";

export interface HumorPattern {
  type: "setup-punchline" | "roast" | "self-deprecation" | "callback-eruption" | "crash-out" | "visual-gag" | "reaction-chain";
  confidence: number; // 0-1
  triggerTimeSec: number;
  payoffTimeSec: number;
  description: string;
  supportingEvidence: string[];
}

/* ── PATTERN 1: SETUP→PUNCHLINE ── */
function detectSetupPunchline(scene: Scene): HumorPattern | null {
  if (!scene.audio.hasValleyToPeak || !scene.chat.hasDeadToEruption) return null;

  const valleyTime = scene.audio.valleyTimeSec ?? scene.startSec;
  const peakTime = scene.audio.peakTimeSec ?? scene.startSec + scene.durationSec * 0.7;
  const deadTime = scene.chat.deadTimeSec ?? scene.startSec;
  const eruptionTime = scene.chat.eruptionTimeSec ?? scene.startSec + scene.durationSec * 0.7;

  // Setup = audio valley, payoff = audio peak + chat eruption
  const setupDuration = peakTime - valleyTime;
  const payoffDuration = eruptionTime - deadTime;

  if (setupDuration < 2 || setupDuration > 20) return null;
  if (payoffDuration < 1 || payoffDuration > 10) return null;

  // Check transcript for question/setup words before peak
  const setupWords = scene.words.filter(w => w.startMs / 1000 < peakTime && w.startMs / 1000 >= valleyTime);
  const hasSetupCue = setupWords.some(w => /what|how|why|did you|remember|so/i.test(w.word));

  // Check for punchline words at peak
  const punchlineWords = scene.words.filter(w => Math.abs(w.startMs / 1000 - peakTime) < 3);
  const hasPunchline = punchlineWords.some(w => /haha|lmao|no way|what|holy|bro|dude|omg/i.test(w.word));

  const confidence = (hasSetupCue ? 0.3 : 0.1) + (hasPunchline ? 0.3 : 0.1) + 0.3; // base for valley+peak

  if (confidence < 0.5) return null;

  return {
    type: "setup-punchline",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: valleyTime,
    payoffTimeSec: peakTime,
    description: `Setup→Punchline: ${setupDuration.toFixed(1)}s setup, audio peak at ${peakTime.toFixed(1)}s`,
    supportingEvidence: [
      hasSetupCue ? "setup cue in transcript" : "audio valley detected",
      hasPunchline ? "punchline words at peak" : "audio peak detected",
      scene.chat.hasDeadToEruption ? "chat erupts after quiet" : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 2: ROAST ── */
const ROAST_TRIGGERS = /\b(you're|you are|your|look at you|what is that|what are you|who|nobody|everyone|always|never|trash|garbage|dog|sus|cringe|weird|ugly|bald|short|fat|old|stupid|dumb|idiot|loser)\b/i;
const ROAST_PAYOFF = /\b(haha|lmao|lmfao|rofl|dead|dying|crying|i'm dead|i'm crying|no way|bro what)\b/i;

function detectRoast(scene: Scene): HumorPattern | null {
  const words = scene.words;
  if (words.length < 5) return null;

  // Find insult in first 60% of scene
  const splitPoint = scene.startSec + scene.durationSec * 0.6;
  const setupWords = words.filter(w => w.startMs / 1000 < splitPoint);
  const payoffWords = words.filter(w => w.startMs / 1000 >= splitPoint);

  const hasRoastTrigger = setupWords.some(w => ROAST_TRIGGERS.test(w.word));
  const hasRoastPayoff = payoffWords.some(w => ROAST_PAYOFF.test(w.word));

  // Also check chat for laugh reaction after insult
  const roastWord = setupWords.find(w => ROAST_TRIGGERS.test(w.word));
  const roastTime = roastWord ? roastWord.startMs / 1000 : 0;
  const chatAfterRoast = scene.messages.filter(m => m.timestampSec >= roastTime && m.timestampSec < roastTime + 5);
  const chatLaughReaction = chatAfterRoast.some(m => /\b(lmao|lmfao|haha|dead|rofl)\b/i.test(m.text));

  const confidence = (hasRoastTrigger ? 0.35 : 0) + (hasRoastPayoff ? 0.3 : 0) + (chatLaughReaction ? 0.35 : 0);

  if (confidence < 0.5) return null;

  return {
    type: "roast",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: roastTime || scene.startSec,
    payoffTimeSec: payoffWords.length > 0 ? payoffWords[0].startMs / 1000 : scene.startSec + scene.durationSec * 0.7,
    description: `Roast: "${roastWord?.word || "insult"}" → laugh payoff`,
    supportingEvidence: [
      hasRoastTrigger ? "insult trigger in transcript" : "",
      hasRoastPayoff ? "laugh payoff in transcript" : "",
      chatLaughReaction ? "chat laughs at roast" : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 3: SELF-DEPRECATION ── */
const SELF_DEPRECATION_TRIGGERS = /\b(i'm|i am|i look|i sound|i can't|i suck|i'm bad|i'm trash|i'm garbage|i'm the worst|i'm so|i'm literally|i'm actually)\b/i;
const SELF_DEPRECATION_NEGATIVE = /\b(bad|trash|garbage|worst|suck|terrible|awful|cringe|weird|stupid|dumb|ugly|bald|short|fat|old|broke|poor|loser|failure)\b/i;
const SYMPATHY_LAUGH = /\b(haha|lmao|aww|no|same|relatable|mood|literally me|i feel that|that's me)\b/i;

function detectSelfDeprecation(scene: Scene): HumorPattern | null {
  const words = scene.words;
  if (words.length < 5) return null;

  // Find "I" + negative pattern
  let hasSelfDep = false;
  let triggerTime = 0;
  for (let i = 0; i < words.length - 2; i++) {
    const w1 = words[i].word.toLowerCase();
    const w2 = words[i + 1].word.toLowerCase();
    if (SELF_DEPRECATION_TRIGGERS.test(w1) && SELF_DEPRECATION_NEGATIVE.test(w2)) {
      hasSelfDep = true;
      triggerTime = words[i].startMs / 1000;
      break;
    }
  }

  // Check for sympathy laugh in chat or audio after self-dep
  const chatAfter = scene.messages.filter(m => m.timestampSec >= triggerTime && m.timestampSec < triggerTime + 5);
  const hasSympathy = chatAfter.some(m => SYMPATHY_LAUGH.test(m.text));

  // Audio laugh detection after self-dep
  const audioAfter = scene.samples.filter(s => s.timeSec >= triggerTime && s.timeSec < triggerTime + 5);
  const hasAudioLaugh = audioAfter.some(s => s.rmsLevel > -30);

  const confidence = (hasSelfDep ? 0.4 : 0) + (hasSympathy ? 0.3 : 0) + (hasAudioLaugh ? 0.3 : 0);

  if (confidence < 0.5) return null;

  return {
    type: "self-deprecation",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: triggerTime,
    payoffTimeSec: triggerTime + 2,
    description: "Self-deprecation → audience sympathy laugh",
    supportingEvidence: [
      hasSelfDep ? `"I" + negative self-talk detected` : "",
      hasSympathy ? "chat sympathy reaction" : "",
      hasAudioLaugh ? "audio laugh after self-dep" : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 4: CALLBACK ERUPTION ── */
function detectCallbackEruption(scene: Scene): HumorPattern | null {
  // Chat is quiet for first 50%, then explodes on a keyword
  const midPoint = scene.startSec + scene.durationSec * 0.5;
  const earlyChat = scene.messages.filter(m => m.timestampSec < midPoint);
  const lateChat = scene.messages.filter(m => m.timestampSec >= midPoint);

  const earlyRate = earlyChat.length / (midPoint - scene.startSec);
  const lateRate = lateChat.length / (scene.endSec - midPoint);

  if (earlyRate > 0.5) return null; // Not quiet enough
  if (lateRate < 3.0) return null; // Not explosive enough

  // Find the trigger word that caused the explosion
  const triggerMessages = lateChat.slice(0, 3);
  const triggerWords = triggerMessages.map(m => m.text).join(" ");

  // Check if it's a callback (references something from earlier in stream)
  const isCallback = /\b(back|again|same|still|always|every time|remember|like before|like last time|classic)\b/i.test(triggerWords);

  const confidence = 0.3 + (isCallback ? 0.4 : 0.1) + (lateRate > 5 ? 0.3 : 0.1);

  if (confidence < 0.5) return null;

  const firstLateMsg = lateChat[0];
  const triggerTime = firstLateMsg ? firstLateMsg.timestampSec : midPoint;

  return {
    type: "callback-eruption",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: triggerTime,
    payoffTimeSec: triggerTime + 1,
    description: `Callback eruption: ${earlyRate.toFixed(1)}msg/s → ${lateRate.toFixed(1)}msg/s`,
    supportingEvidence: [
      `chat quiet early (${earlyRate.toFixed(1)} msg/s)`,
      `chat explodes late (${lateRate.toFixed(1)} msg/s)`,
      isCallback ? "callback reference detected" : "generic eruption",
    ],
  };
}

/* ── PATTERN 5: CRASH-OUT ── */
const FRUSTRATION_MARKERS = /\b(this game|are you serious|every single time|i hate this|i can't|how is that|that's bull|i'm leaving|i'm getting off|i quit|turn this off|broken|trash|garbage|dog water|cheating|lagging)\b/i;
const FRUSTRATION_ESCALATION = /\b(what|how|why|no|stop|please|come on|are you kidding|you've got to be kidding|i'm done|i'm so done|that's it|i'm out)\b/i;

function detectCrashOut(scene: Scene): HumorPattern | null {
  const words = scene.words;
  if (words.length < 5) return null;

  // Look for escalating frustration markers
  const frustrationWords = words.filter(w => FRUSTRATION_MARKERS.test(w.word));
  const escalationWords = words.filter(w => FRUSTRATION_ESCALATION.test(w.word));

  if (frustrationWords.length < 2 && escalationWords.length < 3) return null;

  // Audio should show escalation (rising RMS)
  const rmsValues = scene.samples.map(s => s.rmsLevel);
  let hasEscalation = false;
  for (let i = 1; i < rmsValues.length; i++) {
    if (rmsValues[i] - rmsValues[i - 1] > 8) {
      hasEscalation = true;
      break;
    }
  }

  // Chat should have shock reactions
  const shockReactions = scene.messages.filter(m => /\b(wtf|omg|no way|bro what|holy|gasp|nah|crazy|insane)\b/i.test(m.text));

  // Peak should be followed by silence (crash-out resolution)
  const maxRms = Math.max(...rmsValues, -100);
  const maxRmsIdx = rmsValues.indexOf(maxRms);
  const postPeakSamples = rmsValues.slice(maxRmsIdx + 1, maxRmsIdx + 10);
  const postPeakAvg = postPeakSamples.length > 0 ? postPeakSamples.reduce((a, b) => a + b, 0) / postPeakSamples.length : -100;
  const hasCrashSilence = postPeakAvg < -40;

  const confidence = (frustrationWords.length >= 2 ? 0.25 : 0) + (escalationWords.length >= 3 ? 0.25 : 0) +
    (hasEscalation ? 0.2 : 0) + (shockReactions.length > 0 ? 0.15 : 0) + (hasCrashSilence ? 0.15 : 0);

  if (confidence < 0.5) return null;

  const peakTime = scene.samples[maxRmsIdx]?.timeSec ?? scene.startSec + scene.durationSec * 0.7;

  return {
    type: "crash-out",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: frustrationWords.length > 0 ? frustrationWords[0].startMs / 1000 : scene.startSec,
    payoffTimeSec: peakTime,
    description: `Crash-out: ${frustrationWords.length} frustration markers → peak → ${hasCrashSilence ? "silence" : "tail"}`,
    supportingEvidence: [
      frustrationWords.length > 0 ? `${frustrationWords.length} frustration phrases` : "",
      escalationWords.length > 0 ? `${escalationWords.length} escalation phrases` : "",
      hasEscalation ? "audio escalation detected" : "",
      shockReactions.length > 0 ? `${shockReactions.length} chat shock reactions` : "",
      hasCrashSilence ? "crash silence after peak" : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 5b: SILENCE → EXPLOSION (comedic timing) ── */
function detectSilenceExplosion(scene: Scene): HumorPattern | null {
  // Classic comedic timing: dead air → sudden audio peak + chat eruption
  // This catches deadpan delivery, unexpected punchlines, surprise moments

  // Need at least some audio samples to detect silence
  if (scene.samples.length < 5) return null;

  // Find silence valleys (RMS < -45 dB for 2+ seconds)
  let silenceStart: number | null = null;
  let silenceEnd: number | null = null;
  let longestSilenceStart = scene.startSec;
  let longestSilenceEnd = scene.startSec;
  let longestSilenceDur = 0;

  for (let i = 0; i < scene.samples.length; i++) {
    const s = scene.samples[i];
    if (s.rmsLevel < -45) {
      if (silenceStart === null) silenceStart = s.timeSec;
      silenceEnd = s.timeSec;
    } else {
      if (silenceStart !== null && silenceEnd !== null) {
        const dur = silenceEnd - silenceStart;
        if (dur > longestSilenceDur) {
          longestSilenceDur = dur;
          longestSilenceStart = silenceStart;
          longestSilenceEnd = silenceEnd;
        }
      }
      silenceStart = null;
      silenceEnd = null;
    }
  }

  // Need at least 1.5s of silence for comedic timing
  if (longestSilenceDur < 1.5) return null;

  // After silence, must have audio explosion (peak > -28 dB within 3s)
  const postSilenceSamples = scene.samples.filter(s => s.timeSec > longestSilenceEnd && s.timeSec <= longestSilenceEnd + 3);
  const hasAudioExplosion = postSilenceSamples.some(s => s.rmsLevel > -28);
  const postSilenceMaxRms = postSilenceSamples.length > 0 ? Math.max(...postSilenceSamples.map(s => s.rmsLevel)) : -100;

  // After silence, must have chat eruption (3+ messages in 3s window)
  const postSilenceChat = scene.messages.filter(m => m.timestampSec > longestSilenceEnd && m.timestampSec <= longestSilenceEnd + 3);
  const hasChatEruption = postSilenceChat.length >= 3;

  // Need at least audio explosion OR chat eruption
  if (!hasAudioExplosion && !hasChatEruption) return null;

  // Calculate confidence
  let confidence = 0.3; // base for having silence + some reaction
  if (hasAudioExplosion) confidence += 0.25;
  if (hasChatEruption) confidence += 0.25;
  if (longestSilenceDur > 2.5) confidence += 0.1; // longer silence = better timing
  if (postSilenceMaxRms > -20) confidence += 0.1; // very loud explosion

  if (confidence < 0.5) return null;

  // Find the explosion peak time
  const explosionPeak = postSilenceSamples.length > 0
    ? postSilenceSamples.reduce((a, b) => a.rmsLevel > b.rmsLevel ? a : b)
    : null;
  const peakTime = explosionPeak?.timeSec ?? longestSilenceEnd + 1;

  return {
    type: "setup-punchline",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: longestSilenceStart,
    payoffTimeSec: peakTime,
    description: `Silence→Explosion: ${longestSilenceDur.toFixed(1)}s dead air → ${hasAudioExplosion ? "audio peak" : ""}${hasAudioExplosion && hasChatEruption ? " + " : ""}${hasChatEruption ? "chat eruption" : ""}`,
    supportingEvidence: [
      `${longestSilenceDur.toFixed(1)}s silence valley`,
      hasAudioExplosion ? `audio explosion to ${postSilenceMaxRms.toFixed(0)}dB` : "",
      hasChatEruption ? `${postSilenceChat.length} chat messages in 3s` : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 6: VISUAL GAG ── */
// STRICT visual cue words — "that" alone is NOT a visual cue. Must be explicit visual direction.
// v2 fix: "see" as a standalone word (e.g. "I see", "that's") is NOT a visual cue.
const VISUAL_CUE_WORDS_STRICT = /\b(look|look\s+at|watch|watch\s+this|there\s+(it\s+is|he\s+is|she\s+is|they\s+are|that\s+is)|oh\s+my\s+(god|gosh)|holy\s+(shit|crap|moly)|what\s+(is|are|the)\s+(doing|that|this|happening)|did\s+you\s+see|check\s+this\s+out|check\s+that\s+out|look\s+at\s+(this|that|him|her|it|them))\b/i;
const GAME_EVENT_WORDS = /\b(kill|death|died|fall|fell|jump|crash|crashed|explode|exploded|glitch|bug|clip|shot|snipe|sniped|clutch|aced|win|lose|lost|fail|failed|wipe|wiped|wipeout|team\s+kill|friendly\s+fire)\b/i;

function detectVisualGag(scene: Scene): HumorPattern | null {
  const words = scene.words;
  if (words.length < 3) return null;

  // STRICT: Only explicit visual direction words count
  // v2 fix: Reject standalone "see" / "that" / "this" — must be part of a visual-direction phrase
  const visualCues = words.filter(w => {
    const text = w.word.toLowerCase();
    // Quick reject: standalone filler words that aren't visual direction
    if (/^(see|that|this|there|here|it|he|she|they)$/i.test(text)) return false;
    // Must match the strict pattern
    return VISUAL_CUE_WORDS_STRICT.test(w.word);
  });

  // Also accept game event words as visual context (something happened on screen)
  const gameEvents = words.filter(w => GAME_EVENT_WORDS.test(w.word));

  // Need at least 1 strict visual cue OR 2+ game events + strong chat reaction
  const hasStrictVisualCue = visualCues.length >= 1;
  const hasGameEventContext = gameEvents.length >= 2;

  if (!hasStrictVisualCue && !hasGameEventContext) return null;

  // Chat must react strongly — this is the key differentiator from false positives
  const chatReactions = scene.messages.filter(m => /\b(lmao|lmfao|haha|wtf|omg|no\s+way|bro\s+what|dead|dying|crazy|insane|gasp|clutch|ace|pog|poggers)\b/i.test(m.text));

  // Audio must have a clear spike (reaction to visual)
  const maxRms = Math.max(...scene.samples.map(s => s.rmsLevel), -100);
  const hasAudioSpike = maxRms > -28; // Raised threshold — must be genuinely loud

  // Confidence: strict visual cues get higher base, game events need more chat support
  let confidence = 0;
  if (hasStrictVisualCue) {
    confidence += 0.35;
  } else if (hasGameEventContext) {
    confidence += 0.20; // Lower base for game events alone
  }

  // Chat reactions: need MORE for game-event-only scenes
  const minChatForGameEvent = 5;
  const minChatForVisualCue = 3;
  if (hasStrictVisualCue && chatReactions.length >= minChatForVisualCue) {
    confidence += 0.35;
  } else if (hasGameEventContext && chatReactions.length >= minChatForGameEvent) {
    confidence += 0.35;
  } else if (chatReactions.length >= 2) {
    confidence += 0.15; // Weak chat support
  }

  // Audio spike bonus
  if (hasAudioSpike) {
    confidence += 0.30;
  } else if (maxRms > -35) {
    confidence += 0.10;
  }

  if (confidence < 0.6) return null; // Raised threshold from 0.5 to 0.6

  const firstCue = visualCues[0] ?? gameEvents[0];

  return {
    type: "visual-gag",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: firstCue.startMs / 1000,
    payoffTimeSec: firstCue.startMs / 1000 + 2,
    description: `Visual gag: "${firstCue.word}" + ${chatReactions.length} chat reactions`,
    supportingEvidence: [
      hasStrictVisualCue ? `${visualCues.length} strict visual cue words` : "",
      hasGameEventContext ? `${gameEvents.length} game event words` : "",
      `${chatReactions.length} chat reactions`,
      hasAudioSpike ? "strong audio reaction" : maxRms > -35 ? "moderate audio reaction" : "weak audio reaction",
    ].filter(Boolean),
  };
}

/* ── PATTERN 7: REACTION CHAIN ── */
function detectReactionChain(scene: Scene): HumorPattern | null {
  // Streamer says something → chat reacts → streamer reacts to chat reaction
  const words = scene.words;
  const messages = scene.messages;
  if (words.length < 5 || messages.length < 3) return null;

  // Find chat burst
  const chatTimes = messages.map(m => m.timestampSec);
  let chatBurstStart = 0;
  let chatBurstEnd = 0;
  let maxBurstCount = 0;

  for (let i = 0; i < chatTimes.length; i++) {
    let count = 1;
    for (let j = i + 1; j < chatTimes.length && chatTimes[j] - chatTimes[i] <= 5; j++) {
      count++;
    }
    if (count > maxBurstCount) {
      maxBurstCount = count;
      chatBurstStart = chatTimes[i];
      chatBurstEnd = chatTimes[i] + 5;
    }
  }

  if (maxBurstCount < 3) return null;

  // Find streamer words before chat burst (the trigger)
  const triggerWords = words.filter(w => w.startMs / 1000 < chatBurstStart && w.startMs / 1000 >= chatBurstStart - 10);
  const hasTrigger = triggerWords.length > 0;

  // Find streamer words after chat burst (reaction to reaction)
  const reactionWords = words.filter(w => w.startMs / 1000 > chatBurstEnd && w.startMs / 1000 <= chatBurstEnd + 8);
  const hasReaction = reactionWords.length > 0;

  // Check if streamer reaction has laugh/shock markers
  const streamerReacts = reactionWords.some(w => /\b(haha|lmao|what|no way|oh my|bro|dude|wait|hold on|stop|please)\b/i.test(w.word));

  const confidence = (hasTrigger ? 0.25 : 0) + (hasReaction ? 0.25 : 0) + (streamerReacts ? 0.3 : 0) + (maxBurstCount >= 5 ? 0.2 : 0.1);

  if (confidence < 0.5) return null;

  return {
    type: "reaction-chain",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: chatBurstStart - 5,
    payoffTimeSec: chatBurstEnd + 2,
    description: `Reaction chain: streamer → ${maxBurstCount} chat msgs → streamer reacts`,
    supportingEvidence: [
      hasTrigger ? "streamer trigger before chat" : "",
      `${maxBurstCount} chat messages in 5s`,
      hasReaction ? "streamer reacts to chat" : "",
      streamerReacts ? "streamer laugh/shock in reaction" : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 8: CHAT ROAST (chat roasting the streamer) ── */
const CHAT_ROAST_WORDS = /\b(you\s+suck|you're\s+bad|you\s+trash|garbage|dog\s+water|bald|short|fat|ugly|stupid|dumb|idiot|loser|noob|ez|get\s+rekt|rekt|owned|clapped|ratio|L\s+take|bad\s+take|cringe|sus|sussy|baka|pepega|5head|smooth\s+brain)\b/i;
const STREAMER_NAME_PATTERNS = /\b(peanut|cloy|streamer|bro|dude|man|guy)\b/i;

function detectChatRoast(scene: Scene): HumorPattern | null {
  // Chat is roasting the streamer — look for insults directed at "peanut" or "streamer"
  const roastMessages = scene.messages.filter(m => {
    const text = m.text.toLowerCase();
    // Must contain a roast word AND reference the streamer (or be clearly directed)
    const hasRoastWord = CHAT_ROAST_WORDS.test(text);
    const hasStreamerRef = STREAMER_NAME_PATTERNS.test(text);
    // Also accept messages that are just roast words with @ or directed tone
    const isDirected = text.includes("@") || text.includes("you") || text.startsWith("peanut") || text.startsWith("cloy");
    return hasRoastWord && (hasStreamerRef || isDirected);
  });

  if (roastMessages.length < 2) return null;

  // Streamer should react (audio spike or verbal response)
  const firstRoast = roastMessages[0];
  const roastTime = firstRoast.timestampSec;
  const streamerWordsAfter = scene.words.filter(w => w.startMs / 1000 >= roastTime && w.startMs / 1000 < roastTime + 5);
  const streamerReacts = streamerWordsAfter.length > 0;

  // Audio should have reaction spike
  const audioAfter = scene.samples.filter(s => s.timeSec >= roastTime && s.timeSec < roastTime + 3);
  const hasAudioReaction = audioAfter.some(s => s.rmsLevel > -30);

  // Other chat should laugh at the roast
  const chatAfter = scene.messages.filter(m => m.timestampSec >= roastTime && m.timestampSec < roastTime + 5);
  const laughAtRoast = chatAfter.some(m => /\b(lmao|lmfao|haha|dead|dying|rofl|pog|poggers)\b/i.test(m.text));

  const confidence = (roastMessages.length >= 3 ? 0.3 : 0.2) +
    (streamerReacts ? 0.25 : 0) +
    (hasAudioReaction ? 0.25 : 0) +
    (laughAtRoast ? 0.2 : 0);

  if (confidence < 0.5) return null;

  return {
    type: "roast",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: roastTime,
    payoffTimeSec: streamerWordsAfter.length > 0 ? streamerWordsAfter[streamerWordsAfter.length - 1].startMs / 1000 : roastTime + 2,
    description: `Chat roast: ${roastMessages.length} insults → streamer reacts`,
    supportingEvidence: [
      `${roastMessages.length} chat roast messages`,
      streamerReacts ? "streamer verbal reaction" : "",
      hasAudioReaction ? "audio reaction spike" : "",
      laughAtRoast ? "chat laughs at roast" : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 9: REPETITION LOOP (same phrase 3+ times = massive viral signal) ── */
const REPETITION_PHRASES = /\b(oh\s+my\s+god|oh\s+no|no\s+way|what\s+the|stop\s+it|come\s+on|are\s+you\s+serious|i\s+can't|i\s+quit|i'm\s+done|that's\s+it|we\s+lost|we\s+won|let's\s+go|let's\s+go+|help\s+me|save\s+me|kill\s+me|i'm\s+dead|i'm\s+literally|bro\s+what|dude\s+what|what\s+is\s+that|what\s+is\s+happening|what\s+is\s+going\s+on|why\s+is\s+this|how\s+is\s+this|this\s+is\s+bad|this\s+is\s+so\s+bad|this\s+is\s+fine|i\s+hate\s+this|i\s+love\s+this|never\s+again|every\s+time|not\s+again|here\s+we\s+go|there\s+it\s+is|i\s+knew\s+it|i\s+told\s+you|you\s+see|you\s+know|you\s+understand)\b/gi;

function detectRepetitionLoop(scene: Scene): HumorPattern | null {
  const words = scene.words;
  if (words.length < 10) return null;

  // Extract all spoken phrases (2-4 word sequences)
  const phrases: { text: string; timeSec: number }[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i].word.toLowerCase().replace(/[^a-z]/g, "");
    const w2 = words[i + 1].word.toLowerCase().replace(/[^a-z]/g, "");
    if (w1.length < 2 || w2.length < 2) continue;
    phrases.push({ text: w1 + " " + w2, timeSec: words[i].startMs / 1000 });
    if (i < words.length - 2) {
      const w3 = words[i + 2].word.toLowerCase().replace(/[^a-z]/g, "");
      if (w3.length >= 2) {
        phrases.push({ text: w1 + " " + w2 + " " + w3, timeSec: words[i].startMs / 1000 });
      }
    }
  }

  // Count phrase frequencies within 10-second windows
  const windowSize = 10;
  const maxSec = words[words.length - 1].startMs / 1000;
  let maxRepeatCount = 0;
  let maxRepeatPhrase = "";
  let maxRepeatTime = 0;

  for (let start = scene.startSec; start <= maxSec - windowSize; start += 2) {
    const windowPhrases = phrases.filter(p => p.timeSec >= start && p.timeSec < start + windowSize);
    const freq = new Map<string, number>();
    for (const p of windowPhrases) {
      freq.set(p.text, (freq.get(p.text) ?? 0) + 1);
    }
    for (const [phrase, count] of freq.entries()) {
      if (count > maxRepeatCount) {
        maxRepeatCount = count;
        maxRepeatPhrase = phrase;
        maxRepeatTime = start;
      }
    }
  }

  // Also check chat for repetition (chat echoing the same phrase)
  const chatTexts = scene.messages.map(m => m.text.toLowerCase());
  let chatMaxRepeat = 0;
  for (const phrase of phrases.map(p => p.text)) {
    const chatCount = chatTexts.filter(t => t.includes(phrase)).length;
    if (chatCount > chatMaxRepeat) chatMaxRepeat = chatCount;
  }

  // Need 3+ repetitions in transcript OR 3+ in chat echoing
  const totalRepeat = Math.max(maxRepeatCount, chatMaxRepeat);
  if (totalRepeat < 3) return null;

  // Check for escalating audio during repetition = panic loop
  const repeatSamples = scene.samples.filter(s => s.timeSec >= maxRepeatTime && s.timeSec < maxRepeatTime + windowSize);
  const hasEscalation = repeatSamples.length > 2 && repeatSamples[repeatSamples.length - 1].rmsLevel > repeatSamples[0].rmsLevel + 8;

  // Confidence: 3 reps = 0.6, 4+ reps = 0.8, 5+ reps = 0.95, with escalation bonus
  let confidence = Math.min(0.5 + (totalRepeat - 2) * 0.15, 0.95);
  if (hasEscalation) confidence += 0.1;
  if (chatMaxRepeat >= 3) confidence += 0.1; // chat echoing = viral signal

  return {
    type: "setup-punchline",
    confidence: Math.min(confidence, 1.0),
    triggerTimeSec: maxRepeatTime,
    payoffTimeSec: maxRepeatTime + windowSize * 0.7,
    description: `Repetition loop: "${maxRepeatPhrase}" x${totalRepeat}${hasEscalation ? " (escalating)" : ""}${chatMaxRepeat >= 3 ? " + chat echo" : ""}`,
    supportingEvidence: [
      `"${maxRepeatPhrase}" repeated ${maxRepeatCount}x in transcript`,
      chatMaxRepeat >= 3 ? `chat echoed ${chatMaxRepeat}x` : "",
      hasEscalation ? "audio escalation during loop" : "",
    ].filter(Boolean),
  };
}

/* ── PATTERN 10: CALM BEFORE STORM (quiet 3-5s → explosion = viral gold) ── */
function detectCalmBeforeStorm(scene: Scene): HumorPattern | null {
  if (scene.samples.length < 10 || scene.durationSec < 8) return null;

  // Find quiet periods (3-5s of low audio) followed by sudden explosion
  const samples = scene.samples;
  let bestCalmStart = 0;
  let bestCalmEnd = 0;
  let bestExplosionTime = 0;
  let bestExplosionRms = -100;
  let bestScore = 0;

  for (let i = 0; i < samples.length - 5; i++) {
    // Look for 3-5s of quiet (< -42 dB)
    let calmStart = samples[i].timeSec;
    let calmEnd = calmStart;
    let j = i;
    while (j < samples.length && samples[j].rmsLevel < -42) {
      calmEnd = samples[j].timeSec;
      j++;
    }
    const calmDuration = calmEnd - calmStart;
    if (calmDuration < 2.5 || calmDuration > 6) continue;

    // Check for explosion within 2s after calm
    const postCalm = samples.filter(s => s.timeSec > calmEnd && s.timeSec <= calmEnd + 2);
    if (postCalm.length === 0) continue;
    const explosionPeak = postCalm.reduce((a, b) => a.rmsLevel > b.rmsLevel ? a : b);
    const explosionRms = explosionPeak.rmsLevel;
    const explosionTime = explosionPeak.timeSec;

    // Must be a genuine explosion (> -25 dB, delta > 20 dB)
    const delta = explosionRms - (-42); // from calm baseline
    if (explosionRms < -25 || delta < 18) continue;

    // Chat should erupt too
    const chatAfter = scene.messages.filter(m => m.timestampSec >= calmEnd && m.timestampSec <= calmEnd + 3);
    const hasChatEruption = chatAfter.length >= 2;

    // Score based on calm duration + explosion magnitude + chat reaction
    let score = (calmDuration / 5) * 0.3 + (delta / 30) * 0.4;
    if (hasChatEruption) score += 0.3;

    if (score > bestScore) {
      bestScore = score;
      bestCalmStart = calmStart;
      bestCalmEnd = calmEnd;
      bestExplosionTime = explosionTime;
      bestExplosionRms = explosionRms;
    }
  }

  if (bestScore < 0.5) return null;

  return {
    type: "setup-punchline",
    confidence: Math.min(bestScore + 0.2, 1.0),
    triggerTimeSec: bestCalmStart,
    payoffTimeSec: bestExplosionTime,
    description: `Calm→Storm: ${(bestCalmEnd - bestCalmStart).toFixed(1)}s quiet → ${bestExplosionRms.toFixed(0)}dB explosion`,
    supportingEvidence: [
      `${(bestCalmEnd - bestCalmStart).toFixed(1)}s of quiet audio`,
      `audio explosion to ${bestExplosionRms.toFixed(0)}dB`,
      scene.messages.filter(m => m.timestampSec >= bestCalmEnd && m.timestampSec <= bestCalmEnd + 3).length >= 2
        ? `${scene.messages.filter(m => m.timestampSec >= bestCalmEnd && m.timestampSec <= bestCalmEnd + 3).length} chat messages post-explosion`
        : "",
    ].filter(Boolean),
  };
}

/* ── MAIN EXPORT ── */
export function detectHumorPatterns(scene: Scene): HumorPattern[] {
  const patterns: (HumorPattern | null)[] = [
    detectSetupPunchline(scene),
    detectSilenceExplosion(scene),
    detectRoast(scene),
    detectChatRoast(scene),
    detectSelfDeprecation(scene),
    detectCallbackEruption(scene),
    detectCrashOut(scene),
    detectVisualGag(scene),
    detectReactionChain(scene),
    detectRepetitionLoop(scene),
    detectCalmBeforeStorm(scene),
  ];

  return patterns.filter((p): p is HumorPattern => p !== null && p.confidence >= 0.5);
}

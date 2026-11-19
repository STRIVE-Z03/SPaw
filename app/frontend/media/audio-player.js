(function () {
  "use strict";
  const locales = {
    zh: "zh-CN",
    "zh-cn": "zh-CN",
    en: "en-GB",
    "en-gb": "en-GB",
    "en-us": "en-US",
  };
  function locale(value) {
    const result =
      locales[
        String(value || "")
          .toLowerCase()
          .replace("_", "-")
      ];
    if (!result) throw new Error("请选择普通话、英式英语或美式英语读音");
    return result;
  }
  function validRecording(recording, language) {
    const url = recording?.url;
    return Boolean(
      /^\/api\/speech\/recordings\/[a-f0-9]{64}$/.test(url || "") &&
        recording.sha256 === url.slice(-64) &&
        recording.language === locale(language),
    );
  }
  function create(options = {}) {
    let generation = 0,
      player = null,
      utterance = null,
      timer = null,
      voiceListener = null,
      heard = false;
    const synth = () => window.speechSynthesis,
      owner = () => String(options.owner?.() || ""),
      status = (text) => options.status?.(text),
      mark = (value) => {
        heard = value;
        options.heard?.(value);
      };
    function clear() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (voiceListener) {
        synth()?.removeEventListener?.("voiceschanged", voiceListener);
        voiceListener = null;
      }
    }
    function stop() {
      generation++;
      clear();
      if (player) {
        player.onplaying = null;
        player.onended = null;
        player.onerror = null;
        player.pause?.();
        player = null;
      }
      if (utterance) {
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
        utterance = null;
      }
      synth()?.cancel?.();
      mark(false);
    }
    function play(text, language, recording) {
      text = String(text || "").trim();
      if (!text || text.length > 120)
        throw new Error("请选择一到一百二十字的词语或短句");
      language = locale(language);
      stop();
      if (options.enabled?.() === false) {
        status("学习声音已关闭，可在设置中开启");
        return;
      }
      const turn = generation,
        actor = owner(),
        current = () => turn === generation && actor === owner();
      let fallbackStarted = false;
      const fixed = Boolean(recording),
        recordingUrl = recording?.url;
      if (fixed && !validRecording(recording, language)) {
        status("这段读音还在核对，准备好后就可以听啦");
        return;
      }
      status("正在准备读音…");
      function failed() {
        if (current()) {
          clear();
          mark(false);
          status("对应读音暂未准备好，请再点一次播放");
        }
      }
      function device() {
        if (fixed) {
          failed();
          return;
        }
        if (!current() || fallbackStarted) return;
        fallbackStarted = true;
        if (player) {
          player.onplaying = null;
          player.onended = null;
          player.onerror = null;
          player.pause?.();
        }
        clear();
        const speech = synth();
        if (!speech || typeof window.SpeechSynthesisUtterance !== "function") {
          failed();
          return;
        }
        function speak() {
          if (!current()) return true;
          const voices = speech.getVoices?.() || [],
            voice = voices.find(
              (v) =>
                String(v.lang).toLowerCase().replace("_", "-") ===
                language.toLowerCase(),
            );
          if (!voice) return false;
          clear();
          let started = false;
          utterance = new window.SpeechSynthesisUtterance(text);
          utterance.lang = language;
          utterance.voice = voice;
          utterance.rate = 0.8;
          utterance.onstart = () => {
            if (current()) {
              started = true;
              mark(true);
              status("正在播放读音…");
            }
          };
          utterance.onend = () => {
            if (current())
              status(
                started
                  ? "听清楚了可以继续，还没听清可再听一次"
                  : "没有成功播放，请重新点击喇叭",
              );
          };
          utterance.onerror = () => {
            if (current()) {
              mark(false);
              status("设备朗读未成功，请重新播放");
            }
          };
          try {
            speech.speak(utterance);
          } catch (_) {
            failed();
          }
          return true;
        }
        if (speak()) return;
        // Empty/lazy voice lists never justify using a voice in another language.
        if (!speech.addEventListener) {
          failed();
          return;
        }
        voiceListener = () => {
          if (current()) speak();
        };
        speech.addEventListener("voiceschanged", voiceListener);
        timer = setTimeout(() => {
          if (!speak()) failed();
        }, 1800);
      }
      if (typeof window.Audio !== "function") {
        device();
        return;
      }
      try {
        player = new window.Audio();
        player.preload = "auto";
        player.src = fixed
          ? recordingUrl
          : "/api/speech?text=" +
            encodeURIComponent(text) +
            "&lang=" +
            encodeURIComponent(language);
        player.onplaying = () => {
          if (current()) {
            clear();
            mark(true);
            status("正在播放读音…");
          }
        };
        player.onended = () => {
          if (current()) {
            clear();
            status(
              heard
                ? "听清楚了可以继续，还没听清可再听一次"
                : "没有成功播放，请重新点击喇叭",
            );
          }
        };
        player.onerror = device;
        timer = setTimeout(device, 14000);
        const promise = player.play();
        promise?.catch((error) => {
          if (!current()) return;
          if (error.name === "NotAllowedError") {
            clear();
            mark(false);
            status("请再次点击喇叭播放读音");
          } else device();
        });
      } catch (_) {
        device();
      }
    }
    return { play, stop, heard: () => heard };
  }
  window.BX_AUDIO = { create, locale, validRecording };
})();

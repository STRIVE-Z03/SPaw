(function () {
  "use strict";
  let app,
    card = null,
    reading = 0,
    owner = "",
    pending = false,
    request = 0;
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  function ruby(tokens) {
    const render = (t) =>
      t.pinyin
        ? `<ruby>${esc(t.text)}<rp>（</rp><rt>${esc(t.pinyin)}</rt><rp>）</rp></ruby>`
        : esc(t.text);
    // Keep short words together without altering the sourced wording or pinyin.
    if (
      tokens.every((t) => [...t.text].length === 1) &&
      typeof Intl.Segmenter === "function"
    ) {
      let offset = 0;
      const chunks = [];
      for (const part of new Intl.Segmenter("zh-CN", {
        granularity: "word",
      }).segment(tokens.map((t) => t.text).join(""))) {
        const count = [...part.segment].length,
          parts = tokens.slice(offset, offset + count).map(render),
          html = parts.join("");
        offset += count;
        if (/^[，。；：！？、）》】”’]+$/.test(part.segment) && chunks.length) {
          const previous = chunks.pop();
          chunks.push(
            previous.endsWith("</span>")
              ? previous.slice(0, -7) + html + "</span>"
              : `<span class="character-ruby-word">${previous}${html}</span>`,
          );
        } else if (part.isWordLike && count > 1 && count <= 4)
          chunks.push(`<span class="character-ruby-word">${html}</span>`);
        else chunks.push(...parts);
      }
      return chunks.join("");
    }
    return tokens.map(render).join("");
  }
  function view(value, connection) {
    app = connection;
    const next = String(app.user()?.id || "");
    if (
      owner !== next ||
      card?.id !== value.id ||
      card?.contentSha256 !== value.contentSha256 ||
      !value.readings[reading]
    ) {
      reading = 0;
      pending = false;
      request++;
    }
    owner = next;
    card = value;
    const row = card.readings[reading],
      word = row.words[0],
      context = word.tokens.find(
        (t) => t.text === card.character && t.pinyin !== row.pinyin,
      );
    const refs = [
      ...new Map(
        (row.sourceRefs || [])
          .filter((r) => /^https:\/\//.test(r.url || ""))
          .map((r) => [r.url, r]),
      ).values(),
    ];
    return `<section class="character-learning" data-character="${esc(card.id)}">${card.preview ? '<p class="character-preview-note">本机字卡预览 · 尚未上线</p>' : ""}<div class="character-reading-choices" aria-label="选择字的读音">${card.readings.length > 1 ? card.readings.map((r, i) => `<button data-character-reading="${i}" aria-pressed="${i === reading}">${esc(r.pinyin)}</button>`).join("") : ""}</div><header class="character-title"><h1>${esc(card.character)}</h1><div><strong>${esc(row.pinyin)}</strong><button data-character-speak aria-label="听${esc(word.text)}，学习${esc(card.character)}的读音">${app.ico("volume-2")}<span>听词语</span></button></div></header>${context ? `<p class="character-sandhi-note">在“${esc(word.text)}”里，${esc(card.character)}读 ${esc(context.pinyin)}${["一", "不"].includes(card.character) ? "（连读变调）" : "（词语轻声）"}。</p>` : ""}<section class="character-meaning"><h2>这个字的意思</h2><small class="character-meaning-context">在“${esc(word.text)}”里认识“${esc(card.character)}”</small><p>${ruby(row.meaningTokens)}</p></section><section class="character-words"><h2>在词语里认识它</h2><div>${row.words.map((w, i) => `<button data-character-word="${i}" aria-label="朗读${esc(w.text)}">${ruby(w.tokens)}${app.ico("volume-2", "small")}</button>`).join("")}</div></section><section class="character-example"><h2>读一句，想一想</h2><p>${ruby(row.example.tokens)}</p><button class="text-action" data-character-example>听这句话</button></section><p class="character-audio-status" role="status" aria-live="polite"></p><button class="primary block" data-character-dictation ${!card.dictationReady || pending ? "disabled" : ""}>${pending ? "正在准备…" : card.dictationReady ? "去听写小站练一练" : "听写读音待核对"}</button><p class="character-dictation-note">听词语读音，认识这个字。</p>${refs.length ? `<details class="character-sources"><summary>辞书来源</summary>${refs.map((r) => `<p><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title || "辞书原义")}</a> · ${esc(r.license || "")}</p>`).join("")}</details>` : ""}</section>`;
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("button");
    if (!button || button.disabled || !app || !card) return;
    if (String(app.user()?.id || "") !== owner) return;
    const d = button.dataset,
      row = card.readings[reading];
    if ("characterReading" in d) {
      const n = Number(d.characterReading);
      if (Number.isInteger(n) && card.readings[n]) {
        app.stopAudio?.();
        request++;
        pending = false;
        reading = n;
        app.render();
      }
      return;
    }
    if ("characterSpeak" in d || "characterWord" in d) {
      const word =
        row.words["characterWord" in d ? Number(d.characterWord) : 0];
      if (word) app.play(word.text, "zh-CN", word.audio || { required: true });
      return;
    }
    if ("characterExample" in d) {
      app.play(
        row.example.text,
        "zh-CN",
        row.example.audio || { required: true },
      );
      return;
    }
    if ("characterDictation" in d) {
      if (!card.dictationReady || pending) return;
      const actor = owner,
        id = card.id,
        index = reading,
        turn = ++request;
      pending = true;
      button.disabled = true;
      button.textContent = "正在准备…";
      try {
        const entry = await app.api(
          "/api/chinese/items/" + id + "/dictation?reading=" + index,
        );
        if (
          !card.dictationReady ||
          turn !== request ||
          reading !== index ||
          actor !== String(app.user()?.id || "") ||
          card?.id !== id ||
          (app.route && (app.route()[0] !== "chinese" || app.route()[1] !== id))
        )
          return;
        await app.startDictation(entry);
      } catch (error) {
        if (actor === String(app.user()?.id || ""))
          app.toast(error.message || "听写词语尚未准备好，请稍后重试");
      } finally {
        if (
          turn === request &&
          reading === index &&
          actor === owner &&
          card?.id === id
        ) {
          pending = false;
          app.render();
        }
      }
    }
  });
  function originalEntry(value) {
    if (
      !value ||
      !Array.isArray(value.fields) ||
      !Array.isArray(value.values) ||
      value.fields.length !== value.values.length
    )
      return "";
    const official =
        /^https:\/\/(?:[a-z0-9-]+\.)*moe\.(?:gov|edu)\.tw(?:\/|$)/.test(
          value.sourceUrl || "",
        ),
      instructions =
        /^\/assets\/licenses\/moe\/(?:minidict|conciseddict|reviseddict)_10312\.odt$/.test(
          value.instructionsFile || "",
        );
    return `<details class="character-sources character-original-source"><summary>出处和完整辞书原文</summary><p>${esc(value.attribution)} · ${esc(value.title)} · ${esc(value.version)}</p><p>原字形、原音和原文保留如下；学习拼音另外核对。</p><dl class="character-original-fields">${value.fields.map((field, i) => `<dt>${esc(field)}</dt><dd>${esc(value.values[i] === null ? "—" : value.values[i])}</dd>`).join("")}</dl><p>${official ? `<a href="${esc(value.sourceUrl)}" target="_blank" rel="noopener noreferrer">官方来源</a>` : ""}${instructions ? ` · <a href="${esc(value.instructionsFile)}" target="_blank" rel="noopener noreferrer">完整使用说明</a>` : ""}</p></details>`;
  }
  function render(value, connection) {
    const html = view(value, connection),
      source = originalEntry(value.readings[reading]?.originalDictionaryEntry);
    return source ? html.slice(0, -10) + source + "</section>" : html;
  }
  window.BX_CHARACTERS = { view: render, ruby };
})();

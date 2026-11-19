(function () {
  "use strict";
  const escape = (value) =>
    String(value).replace(
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
  let parser;
  function mathHtml(math, display) {
    return (
      '<span class="bx-math' +
      (display ? " bx-math-display" : "") +
      '">' +
      escape(math) +
      "</span>"
    );
  }
  function markdown(text, { allowLinks = true } = {}) {
    text = String(text || "").slice(0, 60000);
    if (!window.marked || !window.DOMPurify?.isSupported)
      return escape(text)
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br>");
    if (!parser) {
      parser = new window.marked.Marked({ gfm: true, breaks: true });
      parser.use({
        extensions: [
          {
            name: "pawMathBlock",
            level: "block",
            tokenizer(src) {
              const m =
                /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(src);
              if (m)
                return { type: "pawMathBlock", raw: m[0], text: m[1] || m[2] };
            },
            renderer(token) {
              return mathHtml(token.text, true);
            },
          },
          {
            name: "pawMath",
            level: "inline",
            start(src) {
              return src.search(/\$|\\[([]/);
            },
            tokenizer(src) {
              const m =
                /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$)/.exec(
                  src,
                );
              if (m)
                return {
                  type: "pawMath",
                  raw: m[0],
                  text: m[1] || m[2] || m[3] || m[4],
                  display: !!(m[1] || m[2]),
                };
            },
            renderer(token) {
              return mathHtml(token.text, token.display);
            },
          },
        ],
      });
    }
    const html = parser.parse(text);
    return window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "p",
        "br",
        "span",
        "strong",
        "em",
        "b",
        "i",
        "s",
        "del",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "pre",
        "code",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "hr",
        "a",
        "sup",
        "sub",
      ],
      ALLOWED_ATTR: ["href", "title", "class", "start"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ...(allowLinks ? {} : { FORBID_TAGS: ["a"] }),
    });
  }
  function typeset(elements) {
    if (!window.katex) return;
    for (const element of elements || [])
      for (const math of element.querySelectorAll(".bx-math")) {
        if (math.dataset.rendered) continue;
        const text = math.textContent;
        window.katex.render(text, math, {
          displayMode: math.classList.contains("bx-math-display"),
          throwOnError: false,
          trust: false,
          maxExpand: 500,
          maxSize: 15,
          strict: "ignore",
        });
        math.dataset.rendered = "1";
      }
  }
  async function stream(body, { signal, onEvent } = {}) {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(
        data.error ||
          ([429, 503].includes(response.status)
            ? "请求有些密集，稍等片刻再试，题目已经保留。"
            : "暂时连接不上，请稍后重试"),
      );
      error.status = response.status;
      throw error;
    }
    let buffer = "",
      result = null;
    function consume(frame) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) return;
      let event;
      try {
        event = JSON.parse(data);
      } catch (_) {
        throw new Error("回答传输中断，题目已保留，请重试");
      }
      if (event.type === "error")
        throw new Error(event.message || "回答中断，可保留题目重试");
      if (event.type === "done") result = event;
      onEvent?.(event);
    }
    if (!response.body?.getReader || typeof TextDecoder !== "function") {
      const text = await response.text();
      for (const frame of text.split(/\r?\n\r?\n/))
        if (frame.trim()) consume(frame);
      if (!result || typeof result.reply !== "string")
        throw new Error("回答中断，题目与图片已保留，可以重试");
      return result;
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          consume(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
        if (buffer.length > 200000) throw new Error("回答内容异常，请重新提问");
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      if (!result || typeof result.reply !== "string")
        throw new Error("回答中断，题目与图片已保留，可以重试");
      return result;
    } finally {
      try {
        await reader.cancel();
      } catch (_) {}
      reader.releaseLock?.();
    }
  }
  window.BX_CHAT = { markdown, typeset, stream };
})();

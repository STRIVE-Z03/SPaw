(function () {
  "use strict";
  function swipeDecision(start, end, zoom = 100) {
    if (
      !start ||
      !end ||
      zoom > 100 ||
      end.cancelled ||
      start.fingers !== 1 ||
      end.fingers > 1
    )
      return 0;
    const dx = end.x - start.x,
      dy = end.y - start.y,
      elapsed = end.time - start.time;
    return elapsed > 0 &&
      elapsed < 1100 &&
      Math.abs(dx) >= 55 &&
      Math.abs(dx) > Math.abs(dy) * 1.8
      ? dx < 0
        ? 1
        : -1
      : 0;
  }
  function wordChoices(entries, index) {
    const current = entries[index];
    if (!current) return [];
    const norm = (text) =>
      text
        .trim()
        .toLocaleLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\s+/g, " ");
    const spellings = (entry) =>
      [
        entry.text,
        ...(entry.language?.startsWith("en") &&
        Array.isArray(entry.acceptedSpellings)
          ? entry.acceptedSpellings
              .filter((v) => typeof v === "string" && v.length <= 80)
              .slice(0, 8)
          : []),
      ].map(norm);
    const accepted = new Set(spellings(current));
    let other = entries
      .slice(index + 1)
      .concat(entries.slice(0, index))
      .find((entry) => !spellings(entry).some((text) => accepted.has(text)));
    if (!other)
      other = {
        text: current.language?.startsWith("en")
          ? norm(current.text) === "apple"
            ? "school"
            : "apple"
          : current.text === "苹果"
            ? "学校"
            : "苹果",
      };
    const options = [current.text, other.text];
    let hash = 0;
    for (const c of current.text) hash = (hash * 31 + c.codePointAt(0)) >>> 0;
    return hash % 2 ? options.reverse() : options;
  }
  // Page images remain private to this reading session and are never written
  // into browser storage. Pending requests are shared and discarded on exit.
  function createPageCache({
    fetchPage,
    objectURL,
    now = () => Date.now(),
    maxPages = 5,
    maxBytes = 12 * 1024 * 1024,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    retries = 2,
    requestTimeout = 20000,
  } = {}) {
    const entries = new Map(),
      pending = new Map();
    let generation = 0,
      pinned = new Set();
    function remove(key) {
      const entry = entries.get(key);
      if (entry) {
        objectURL.revokeObjectURL(entry.url);
        entries.delete(key);
      }
    }
    function clear() {
      generation++;
      pinned.clear();
      for (const task of pending.values()) {
        task.controller.abort();
        clearTimeout(task.timer);
      }
      pending.clear();
      for (const key of [...entries.keys()]) remove(key);
    }
    function get(key) {
      const entry = entries.get(key);
      if (!entry) return "";
      if (now() - entry.at > 120000 && !pinned.has(key)) {
        remove(key);
        return "";
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.url;
    }
    function trim(protectedKey = "") {
      let bytes = [...entries.values()].reduce(
        (sum, item) => sum + item.size,
        0,
      );
      for (const [key, item] of entries) {
        if (entries.size <= maxPages && bytes <= maxBytes) break;
        if (!pinned.has(key) && key !== protectedKey) {
          bytes -= item.size;
          remove(key);
        }
      }
    }
    async function prepare(key) {
      const hit = get(key);
      if (hit) return hit;
      if (pending.has(key)) return pending.get(key).promise;
      const controller = new AbortController(),
        started = generation;
      const timer = setTimeout(() => controller.abort(), requestTimeout);
      const promise = (async () => {
        let blob;
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await fetchPage(key, {
              signal: controller.signal,
              credentials: "same-origin",
              cache: "no-store",
            });
            if (!response.ok) {
              const error = new Error("图片暂时未能加载");
              error.status = response.status || 0;
              throw error;
            }
            if (!/^image\//i.test(response.headers.get("content-type") || ""))
              throw new Error("返回的内容不是图片");
            blob = await response.blob();
            if (!blob.size || blob.size > maxBytes)
              throw new Error("页面图片过大或为空");
            break;
          } catch (error) {
            const transient =
              error?.name === "TypeError" ||
              [408, 429, 500, 502, 503, 504].includes(error.status);
            if (
              !transient ||
              attempt >= retries ||
              controller.signal.aborted ||
              generation !== started
            )
              throw error;
            await delay(attempt ? 900 : 300);
            if (controller.signal.aborted || generation !== started)
              throw new Error("阅读已结束");
          }
        }
        if (generation !== started || controller.signal.aborted)
          throw new Error("阅读已结束");
        const url = objectURL.createObjectURL(blob);
        entries.set(key, { url, size: blob.size, at: now() });
        // Keep the visible page and the page currently being prepared alive.
        trim(key);
        return get(key);
      })();
      pending.set(key, { controller, promise, timer });
      try {
        return await promise;
      } finally {
        clearTimeout(timer);
        if (pending.get(key)?.promise === promise) pending.delete(key);
      }
    }
    return {
      prepare,
      get,
      clear,
      drop(key) {
        const task = pending.get(key);
        task?.controller.abort();
        clearTimeout(task?.timer);
        pending.delete(key);
        remove(key);
      },
      pin(key) {
        pinned = new Set(key ? [key] : []);
        trim();
      },
      pinAll(keys) {
        pinned = new Set(keys);
        trim();
      },
    };
  }
  const pageCache = createPageCache({
    fetchPage: (...args) => fetch(...args),
    objectURL: globalThis.URL,
  });
  let readerScope = "",
    prefetchQueue = [],
    prefetchRunning = false;
  function enterReader(scope) {
    if (scope !== readerScope) {
      pageCache.clear();
      readerScope = scope;
      prefetchQueue = [];
    }
  }
  function leaveReader() {
    if (readerScope) {
      pageCache.clear();
      readerScope = "";
      prefetchQueue = [];
    }
  }
  function prefetchPages(urls) {
    prefetchQueue = urls.slice();
    if (prefetchRunning) return;
    prefetchRunning = true;
    (async () => {
      try {
        while (readerScope && prefetchQueue.length) {
          const url = prefetchQueue.shift();
          try {
            await pageCache.prepare(url);
          } catch (_) {}
        }
      } finally {
        prefetchRunning = false;
      }
    })();
  }
  let deps, gesture;
  function connect(value) {
    deps = value;
  }
  const stage = (target) => target?.closest?.(".ebook-viewport");
  document.addEventListener(
    "touchstart",
    (event) => {
      const viewport = stage(event.target);
      if (!viewport || event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const touch = event.touches[0];
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        fingers: 1,
        viewport,
        zoom: Number(viewport.dataset.zoom || 100),
      };
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!gesture) return;
      if (event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const touch = event.touches[0],
        dx = touch.clientX - gesture.x,
        dy = touch.clientY - gesture.y;
      // Only horizontal gestures turn a page. Vertical movement and pinch zoom stay native.
      if (
        gesture.zoom <= 100 &&
        Math.abs(dx) > 14 &&
        Math.abs(dx) > Math.abs(dy) * 1.8 &&
        event.cancelable
      )
        event.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener(
    "touchend",
    (event) => {
      if (!gesture) return;
      const start = gesture;
      gesture = null;
      if (
        event.touches.length ||
        !event.changedTouches.length ||
        !start.viewport.isConnected
      )
        return;
      const touch = event.changedTouches[0];
      const direction = swipeDecision(
        start,
        { x: touch.clientX, y: touch.clientY, time: Date.now(), fingers: 1 },
        start.zoom,
      );
      if (direction) deps?.turn(direction);
    },
    { passive: true },
  );
  document.addEventListener(
    "touchcancel",
    () => {
      gesture = null;
    },
    { passive: true },
  );
  let mouse;
  document.addEventListener("pointerdown", (event) => {
    const viewport = stage(event.target);
    if (event.pointerType !== "mouse" || event.button !== 0 || !viewport)
      return;
    mouse = {
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
      fingers: 1,
      viewport,
      zoom: Number(viewport.dataset.zoom || 100),
    };
    if (mouse.zoom <= 100) event.preventDefault();
  });
  document.addEventListener("pointerup", (event) => {
    if (!mouse) return;
    const start = mouse;
    mouse = null;
    if (event.pointerType !== "mouse" || !start.viewport.isConnected) return;
    const direction = swipeDecision(
      start,
      { x: event.clientX, y: event.clientY, time: Date.now(), fingers: 1 },
      start.zoom,
    );
    if (direction) deps?.turn(direction);
  });
  document.addEventListener("pointercancel", () => {
    mouse = null;
  });
  document.addEventListener("keydown", (event) => {
    if (
      document.body.dataset.view !== "reader" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    if (
      event.target.closest?.("input,textarea,select,button,[contenteditable]")
    )
      return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      deps?.turn(event.key === "ArrowRight" ? 1 : -1);
    }
  });
  window.BX_LEARNING = {
    swipeDecision,
    wordChoices,
    connect,
    createPageCache,
    pageCache,
    enterReader,
    leaveReader,
    prefetchPages,
  };
})();

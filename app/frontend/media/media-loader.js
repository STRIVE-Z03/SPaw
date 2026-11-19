/* Public UI assets use versioned device caches. Protected pictures stay in RAM
   for the current account/family only, sharing the reader's bounded cache. */
(function () {
  "use strict";
  const esc = (value) =>
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
  const cache = window.BX_LEARNING.createPageCache({
    fetchPage: (...args) => fetch(...args),
    objectURL: URL,
    maxPages: 8,
    maxBytes: 16 * 1024 * 1024,
  });
  const loading = new WeakMap(),
    failures = new WeakMap(),
    notices = new WeakMap();
  let scope = "",
    queued = false;

  function asset(value) {
    const url = new URL(value, location.href);
    const path = url.pathname.replace(/^\//, "");
    const version = window.BX_IMAGE_VERSIONS?.[path];
    const inline = window.BX_INLINE_IMAGES?.[path];
    if (url.origin === location.origin && inline)
      return "data:image/svg+xml," + encodeURIComponent(inline);
    if (url.origin === location.origin && version) {
      url.searchParams.set("v", version);
      return url.pathname + url.search + url.hash;
    }
    return value;
  }

  function privateKey(value) {
    const url = new URL(value, location.href);
    return url.origin === location.origin && url.pathname.startsWith("/api/")
      ? url.pathname + url.search
      : "";
  }

  function source(value, prepared = "") {
    const key = privateKey(value);
    if (!key) return `src="${esc(asset(value))}"`;
    const hit =
      scope && (prepared.startsWith("blob:") ? prepared : cache.get(key));
    return `data-media-src="${esc(key)}"${hit ? ` src="${esc(hit)}"` : ""}`;
  }

  function setScope(value) {
    value = String(value || "");
    if (scope === value) return;
    cache.clear();
    scope = value;
  }

  function dismiss(image) {
    notices.get(image)?.remove();
    notices.delete(image);
    image.classList.remove("media-recovering");
    image.classList.remove("media-error");
    image.removeAttribute("aria-busy");
  }

  function failed(image, retry) {
    if (!image.isConnected) return;
    dismiss(image);
    image.classList.add("media-recovering");
    image.classList.add("media-error");
    const box = document.createElement("span");
    box.className = "media-retry";
    const label = document.createElement("span");
    label.textContent = "图片未加载";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "重试";
    button.addEventListener("click", () => {
      dismiss(image);
      failures.delete(image);
      retry();
    });
    box.append(label, button);
    // The original picture is often inside a zoom button. Keep retry outside it.
    (image.closest("button") || image).after(box);
    notices.set(image, box);
    image.dispatchEvent?.(new Event("bx-media-error"));
  }

  async function hydrate(image) {
    const key = image.dataset.mediaSrc,
      owner = scope;
    if (!image.isConnected || !owner || !key || loading.has(image)) return;
    if (image.getAttribute("src")?.startsWith("blob:")) return;
    if (failures.has(image)) return;
    const task = { key, owner };
    loading.set(image, task);
    image.setAttribute("aria-busy", "true");
    try {
      const url = await cache.prepare(key);
      if (
        scope !== owner ||
        !image.isConnected ||
        image.dataset.mediaSrc !== key ||
        loading.get(image) !== task
      )
        return;
      image.src = url;
    } catch (error) {
      if (scope !== owner || !image.isConnected || loading.get(image) !== task)
        return;
      failures.set(image, true);
      failed(image, () => load(image, key, true));
    } finally {
      if (loading.get(image) === task) loading.delete(image);
    }
  }

  const lazy =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              if (entry.isIntersecting) {
                lazy.unobserve(entry.target);
                hydrate(entry.target);
              }
          },
          { rootMargin: "200px" },
        )
      : null;

  function mount() {
    queued = false;
    lazy?.disconnect();
    const images = [...document.querySelectorAll("img[data-media-src]")];
    cache.pinAll(images.map((image) => image.dataset.mediaSrc));
    for (const image of images) {
      if (image.loading === "lazy" && !image.getAttribute("src") && lazy)
        lazy.observe(image);
      else hydrate(image);
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(mount);
  }

  function load(image, value, force = false) {
    const key = privateKey(value);
    dismiss(image);
    failures.delete(image);
    loading.delete(image);
    if (!key) {
      image.src = asset(value);
      return;
    }
    if (force) cache.drop(key);
    image.dataset.mediaSrc = key;
    const hit = cache.get(key);
    if (hit) image.src = hit;
    else {
      image.removeAttribute("src");
      hydrate(image);
    }
  }

  document.addEventListener(
    "load",
    (event) => {
      if (event.target.tagName === "IMG") {
        dismiss(event.target);
        failures.delete(event.target);
      }
    },
    true,
  );

  document.addEventListener(
    "error",
    (event) => {
      const image = event.target;
      if (
        image.tagName !== "IMG" ||
        image.id === "captcha-image" ||
        !image.isConnected
      )
        return;
      if (image.dataset.mediaSrc) {
        failures.set(image, true);
        failed(image, () => load(image, image.dataset.mediaSrc, true));
        return;
      }
      const original = image.getAttribute("src") || "";
      if (!original || /^(?:blob:|data:)/i.test(original)) return;
      const attempt = (failures.get(image) || 0) + 1;
      failures.set(image, attempt);
      const retry = () => {
        if (!image.isConnected || image.getAttribute("src") !== original)
          return;
        const url = new URL(original, location.href);
        url.searchParams.set("imageRetry", String(attempt));
        image.src = url.href;
      };
      if (attempt <= 2) {
        image.classList.add("media-recovering");
        setTimeout(retry, attempt === 1 ? 300 : 900);
      } else failed(image, retry);
    },
    true,
  );

  if (typeof MutationObserver === "function") {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  window.addEventListener("online", () => {
    for (const image of document.querySelectorAll("img[data-media-src]")) {
      if (failures.has(image)) load(image, image.dataset.mediaSrc, true);
    }
  });
  window.BX_MEDIA = { asset, source, setScope, mount, load };
  schedule();
})();

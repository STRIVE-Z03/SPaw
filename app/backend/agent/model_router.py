"""Discover models, rank recent results, cool down failures and retry safely."""

import http.client, json, time, threading, urllib.request, urllib.error


class ProviderError(ValueError):
    def __init__(self, message, status=0, retry=True):
        super().__init__(message)
        self.status = status
        self.retry = retry


class ModelRouter:
    def __init__(self, config, load, save, http):
        self.config, self.load, self.save, self.http = config, load, save, http
        self.lock = threading.RLock()

    def catalog(self, force=False, timeout=12):
        cached = self.load("ai-model-catalog", {})
        if (
            not force
            and cached.get("models")
            and time.time() - cached.get("at", 0) < 600
        ):
            return cached["models"]
        cfg = self.config()
        req = urllib.request.Request(
            cfg["AI_BASE_URL"] + "/models",
            headers={
                "Authorization": "Bearer " + cfg["AI_API_KEY"],
                "User-Agent": "curl/8.0",
            },
        )
        started = time.monotonic()
        try:
            with self.http.open(req, timeout=timeout) as response:
                body = json.load(response)
            models = [
                m["id"]
                for m in body.get("data", [])
                if isinstance(m, dict)
                and isinstance(m.get("id"), str)
                and "auto-review" not in m["id"].lower()
            ]
            capabilities = {
                m["id"]: dict(
                    vision="supported"
                    if "image" in m["input_modalities"]
                    else "unsupported"
                )
                for m in body.get("data", [])
                if isinstance(m, dict)
                and m.get("id") in models
                and isinstance(m.get("input_modalities"), list)
                and m["input_modalities"]
            }
            if models:
                self.save(
                    "ai-model-catalog",
                    dict(at=time.time(), models=models, capabilities=capabilities),
                )
            self.save(
                "ai-model-catalog-status",
                dict(
                    ok=bool(models),
                    last_status=200 if models else 502,
                    last_at=time.time(),
                    latency_ms=round((time.monotonic() - started) * 1000),
                ),
            )
            return models or cached.get("models", [])
        except (
            OSError,
            ValueError,
            TypeError,
            AttributeError,
            urllib.error.URLError,
            http.client.HTTPException,
        ) as error:
            status = error.code if isinstance(error, urllib.error.HTTPError) else 0
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            self.save(
                "ai-model-catalog-status",
                dict(
                    ok=False,
                    last_status=status,
                    last_at=time.time(),
                    latency_ms=round((time.monotonic() - started) * 1000),
                ),
            )
            return cached.get("models", [])

    def stats(self, vision):
        return self.load("ai-model-health:" + ("vision" if vision else "text"), {})

    def record(self, model, vision, ok, elapsed=0, status=0):
        key = "ai-model-health:" + ("vision" if vision else "text")
        with self.lock:
            stats = self.load(key, {})
            item = stats.setdefault(model, {})
            item["recent"] = (item.get("recent", []) + [bool(ok)])[-20:]
            item.update(
                last_at=time.time(),
                latency_ms=round(elapsed * 1000),
                last_status=status,
            )
            item["cooldown_until"] = (
                0
                if ok
                else time.time() + (900 if status in [400, 404, 405, 422] else 45)
            )
            self.save(key, stats)

    def candidates(self, preferred, vision, models=None):
        models = list(
            dict.fromkeys([preferred, *(self.catalog() if models is None else models)])
        )
        models = [
            m
            for m in models
            if isinstance(m, str) and m and "auto-review" not in m.lower()
        ]
        stats = self.stats(vision)
        now = time.time()

        def rank(model):
            entry = stats.get(model, {})
            recent = entry.get("recent", [])
            # Last successful models precede unknown models; known bad models
            # are skipped during cooldown, then get another chance to recover.
            rate = (sum(recent) + 1) / (len(recent) + 2)
            return (
                -rate,
                0 if model == preferred else 1,
                entry.get("latency_ms", 100000),
            )

        ready = [m for m in models if stats.get(m, {}).get("cooldown_until", 0) <= now]
        return sorted(ready, key=rank) if ready else []

    def request(
        self, model, messages, max_tokens, stream, timeout=45, extra_payload=None
    ):
        cfg = self.config()
        payload = dict(
            model=model, messages=messages, max_tokens=max_tokens, stream=stream
        )
        if extra_payload:
            payload.update(extra_payload)
        request = urllib.request.Request(
            cfg["AI_BASE_URL"] + "/chat/completions",
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            ),
            headers={
                "Authorization": "Bearer " + cfg["AI_API_KEY"],
                "Content-Type": "application/json",
                "Accept": "text/event-stream, application/json"
                if stream
                else "application/json",
                "User-Agent": "curl/8.0",
                "Connection": "close",
            },
        )
        try:
            return self.http.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            # Never echo upstream bodies: they can include credentials or input.
            raise ProviderError(
                "AI 密钥验证失败" if status == 401 else "当前模型暂不可用",
                status,
                status != 401,
            ) from None
        except (OSError, http.client.HTTPException) as error:
            status = (
                408
                if isinstance(error, TimeoutError)
                or isinstance(getattr(error, "reason", None), TimeoutError)
                else 0
            )
            raise ProviderError(
                "模型请求已超时" if status else "模型连接暂时中断", status
            ) from None

    @staticmethod
    def text(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                p["text"]
                for p in content
                if isinstance(p, dict)
                and p.get("type") == "text"
                and isinstance(p.get("text"), str)
            )
        return ""

    @staticmethod
    def _deadline(response, deadline):
        if deadline is None:
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProviderError("模型请求已超时", 408)
        # HTTPResponse's socket timeout must shrink with the total deadline;
        # checking only after each SSE line would let a silent stream hang.
        try:
            response.fp.raw._sock.settimeout(max(0.05, remaining))
        except AttributeError:
            pass

    def read(self, response, emit=None, deadline=None, *, finish_started=False):
        self._deadline(response, deadline)
        stream = "text/event-stream" in response.headers.get("Content-Type", "").lower()
        if not stream:
            result = json.load(response)
            self._deadline(response, deadline)
            if not isinstance(result, dict):
                raise ProviderError("模型输出格式异常", 502)
            if result.get("error"):
                raise ProviderError("模型返回异常", 500)
            choices = result.get("choices")
            if (
                not isinstance(choices, list)
                or not choices
                or not isinstance(choices[0], dict)
                or not isinstance(choices[0].get("message"), dict)
            ):
                raise ProviderError("模型输出格式异常", 502)
            text = self.text(choices[0]["message"].get("content"))
            if emit and text:
                emit("delta", dict(text=text))
            return text
        parts = []
        done = False
        completed_choice = False
        finish_deadline = None
        iterator = iter(response)
        while True:
            self._deadline(response, deadline)
            try:
                raw = next(iterator)
            except StopIteration:
                break
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                done = True
                break
            try:
                item = json.loads(data)
            except json.JSONDecodeError:
                raise ProviderError("模型输出中断", 502) from None
            if not isinstance(item, dict):
                raise ProviderError("模型输出格式异常", 502)
            if item.get("error"):
                raise ProviderError("模型返回异常", 500)
            choices = item.get("choices", [])
            if not isinstance(choices, list):
                raise ProviderError("模型输出格式异常", 502)
            for choice in choices:
                if not isinstance(choice, dict):
                    raise ProviderError("模型输出格式异常", 502)
                delta = choice.get("delta")
                if delta is None:
                    delta = {}
                if not isinstance(delta, dict):
                    raise ProviderError("模型输出格式异常", 502)
                chunk = self.text(delta.get("content"))
                if chunk:
                    self._deadline(response, deadline)
                    if finish_started and chunk.strip():
                        now = time.monotonic()
                        if finish_deadline is None:
                            finish_deadline = now + 120
                        deadline = min(finish_deadline, now + 35)
                    parts.append(chunk)
                    if emit:
                        emit("delta", dict(text=chunk))
                if choice.get("finish_reason") is not None:
                    completed_choice = True
        self._deadline(response, deadline)
        if not done and not completed_choice:
            raise ProviderError("模型输出中断", 502)
        return "".join(parts)

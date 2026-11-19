"""Three private OpenAI-compatible pools with bounded, source-isolated failover."""

import base64, copy, hashlib, http.client, io, json, logging, re, threading, time, urllib.error, urllib.parse, urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from backend.agent.model_router import ModelRouter, ProviderError

PROVIDER_IDS = ("primary", "secondary", "fallback")
CONFIG_KEY = "ai-providers-v1"
UNAVAILABLE = "可能爪爪太累睡着了，晚一会儿再试试吧。题目已保留。"
DEFAULT_POLICY = dict(
    maxAttempts=8, totalSeconds=120, attemptSeconds=60, fallbackReserveSeconds=12
)
VISION_DEADLINE_SECONDS = 75
LOG = logging.getLogger(__name__)


class AIUnavailable(ValueError):
    def __init__(self):
        super().__init__(UNAVAILABLE)


class _ConsumerAborted(Exception):
    def __init__(self, error):
        self.error = error


def _origin(url):
    parsed = urllib.parse.urlsplit(url)
    return (
        parsed.scheme.lower(),
        parsed.hostname.lower() if parsed.hostname else "",
        parsed.port or (443 if parsed.scheme == "https" else 80),
    )


class _SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _origin(req.full_url) != _origin(newurl):
            raise urllib.error.HTTPError(
                req.full_url, code, "Provider redirect rejected", headers, None
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _safe_http(http):
    if http is None:
        return urllib.request.build_opener(_SameOriginRedirect())
    if isinstance(http, urllib.request.OpenerDirector):
        handlers = [
            copy.copy(h)
            for h in http.handlers
            if not isinstance(h, urllib.request.HTTPRedirectHandler)
        ]
        return urllib.request.build_opener(*handlers, _SameOriginRedirect())
    # Injectable HTTP fixtures do not perform redirects. Production's urllib
    # opener above always receives an origin-locked redirect handler.
    return http


def _model_id(value):
    return (
        isinstance(value, str)
        and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/@+\-]{0,159}", value))
        and "::" not in value
        and "auto-review" not in value.lower()
    )


def _base_url(value):
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError("AI 接口地址不正确")
    value = value.strip().rstrip("/")
    try:
        p = urllib.parse.urlsplit(value)
        origin = _origin(value)
    except ValueError:
        raise ValueError("AI 接口地址不正确") from None
    if (
        not p.hostname
        or p.username
        or p.password
        or p.query
        or p.fragment
        or p.scheme not in ("https", "http")
        or any(ord(c) < 33 for c in value)
        or any(part == ".." for part in p.path.split("/"))
    ):
        raise ValueError("请填写不含密钥和查询参数的 AI 接口地址")
    if p.scheme == "http" and p.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("AI 接口需使用 HTTPS")
    path = p.path.rstrip("/")
    for suffix in ("/chat/completions", "/models"):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
    if not path:
        path = "/v1"
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), path, "", ""))


class ProviderRouter:
    def __init__(self, config, load, save, http):
        self.config, self.load, self.save = config, load, save
        self.http = _safe_http(http)
        self.lock = threading.RLock()
        self._routers = {}

    def _providers(self):
        saved = self.load(CONFIG_KEY, None)
        if isinstance(saved, dict) and isinstance(saved.get("providers"), list):
            providers = copy.deepcopy(saved["providers"])
            for provider in providers:
                if (
                    provider["id"] == "fallback"
                    or provider.get("baseUrl")
                    and _origin(provider["baseUrl"])[1] == "api.deepseek.com"
                ):
                    provider["fallbackOnly"] = True
            return providers
        cfg = self.config()
        base = cfg.get("AI_BASE_URL") or ""
        try:
            base = _base_url(base)
        except ValueError:
            base = ""
        primary = dict(
            id="primary",
            name="主要服务",
            baseUrl=base,
            apiKey=cfg.get("AI_API_KEY", ""),
            keyOrigin=base if cfg.get("AI_API_KEY") else "",
            enabled=bool(cfg.get("AI_API_KEY") and base),
            fallbackOnly=bool(base and _origin(base)[1] == "api.deepseek.com"),
            textModel=cfg.get("AI_MODEL", ""),
            visionModel=cfg.get("AI_VISION_MODEL", ""),
            models=[],
        )
        return [
            primary,
            dict(
                id="secondary",
                name="备用服务",
                baseUrl="",
                apiKey="",
                enabled=False,
                fallbackOnly=False,
                textModel="",
                visionModel="",
                models=[],
            ),
            dict(
                id="fallback",
                name="DeepSeek 兜底",
                baseUrl="https://api.deepseek.com/v1",
                apiKey="",
                enabled=False,
                fallbackOnly=True,
                textModel="deepseek-flash",
                visionModel="deepseek-flash",
                models=[],
            ),
        ]

    def _policy(self):
        saved = self.load(CONFIG_KEY, {})
        return {
            **DEFAULT_POLICY,
            **(saved.get("policy", {}) if isinstance(saved, dict) else {}),
        }

    def _router(self, provider):
        fingerprint = hashlib.sha256(
            (provider["baseUrl"] + "\0" + provider.get("apiKey", "")).encode()
        ).hexdigest()[:20]
        identity = provider["id"] + ":" + fingerprint
        with self.lock:
            if identity in self._routers:
                return self._routers[identity]
            prefix = "ai-provider:" + identity + ":"
            legacy = self.config()
            try:
                legacy_match = (
                    provider["id"] == "primary"
                    and _base_url(legacy.get("AI_BASE_URL", "")) == provider["baseUrl"]
                    and legacy.get("AI_API_KEY") == provider.get("apiKey")
                )
            except ValueError:
                legacy_match = False

            def load(key, default=None):
                result = self.load(prefix + key, None)
                if (
                    result is None
                    and legacy_match
                    and key
                    in (
                        "ai-model-catalog",
                        "ai-model-health:text",
                        "ai-model-health:vision",
                    )
                ):
                    result = self.load(key, None)
                return copy.deepcopy(default if result is None else result)

            def save(key, value):
                self.save(prefix + key, value)

            child = ModelRouter(
                lambda: dict(
                    AI_BASE_URL=provider["baseUrl"],
                    AI_API_KEY=provider.get("apiKey", ""),
                ),
                load,
                save,
                self.http,
            )
            self._routers[identity] = child
            return child

    def _provider(self, identity):
        if identity not in PROVIDER_IDS:
            raise ValueError("AI 服务编号不正确")
        return next(p for p in self._providers() if p["id"] == identity)

    @staticmethod
    def _health(entry):
        entry = entry if isinstance(entry, dict) else {}
        recent = [v for v in entry.get("recent", []) if type(v) == bool][-20:]
        return dict(
            recent=recent,
            successRate=round(sum(recent) / len(recent), 4) if recent else None,
            samples=len(recent),
            cooldown_until=entry.get("cooldown_until", 0),
            last_status=entry.get("last_status", 0),
            last_at=entry.get("last_at", 0),
            latency_ms=entry.get("latency_ms", 0),
        )

    def _record_provider(self, provider, ok, status, elapsed):
        child = self._router(provider)
        with self.lock:
            item = child.load("provider-status", {})
            item["recent"] = (item.get("recent", []) + [bool(ok)])[-20:]
            item.update(
                last_status=status,
                last_at=time.time(),
                latency_ms=round(elapsed * 1000),
                cooldown_until=time.time() + 900 if status == 401 else 0,
            )
            child.save("provider-status", item)

    def _vision(self, provider, model):
        child = self._router(provider)
        configured = next(
            (m for m in provider.get("models", []) if m["id"] == model), {}
        )
        if configured.get("vision") == "unsupported":
            return "unsupported"
        verified = child.load("ai-vision-verification", {}).get(model, {})
        if verified.get("vision") in ("supported", "unsupported"):
            return verified["vision"]
        capabilities = (
            child.load("ai-model-catalog", {}).get("capabilities", {}).get(model, {})
        )
        if capabilities.get("vision") in ("supported", "unsupported"):
            return capabilities["vision"]
        # An existing successful image call is evidence, unlike a name guess.
        if any(v is True for v in child.stats(True).get(model, {}).get("recent", [])):
            return "supported"
        return "unknown"

    def _models(self, provider, force=False, deadline=None, fetch=True):
        child = self._router(provider)
        if fetch:
            remaining = deadline - time.monotonic() if deadline else 6
            if remaining <= 0:
                return []
            previous = child.load("ai-model-catalog-status", {}).get("last_at", 0)
            discovered = child.catalog(force, timeout=max(0.05, min(6, remaining)))
            status = child.load("ai-model-catalog-status", {})
            if status.get("last_status") == 401 and status.get("last_at", 0) > previous:
                self._record_provider(
                    provider, False, 401, status.get("latency_ms", 0) / 1000
                )
        else:
            discovered = child.load("ai-model-catalog", {}).get("models", [])
        names = [
            provider.get("textModel"),
            provider.get("visionModel"),
            *(m["id"] for m in provider.get("models", [])),
            *discovered,
        ]
        secret = provider.get("apiKey", "")
        return list(
            dict.fromkeys(
                m for m in names if _model_id(m) and (not secret or secret not in m)
            )
        )

    def _public_provider(self, provider):
        child = self._router(provider)
        text = child.stats(False)
        vision = child.stats(True)
        configured = {m["id"]: m for m in provider.get("models", [])}
        models = [
            dict(
                id=m,
                enabled=configured.get(m, {}).get("enabled", True),
                vision=self._vision(provider, m),
                textHealth=self._health(text.get(m)),
                visionHealth=self._health(vision.get(m)),
            )
            for m in self._models(provider, fetch=False)
        ]
        public = {
            k: provider[k]
            for k in (
                "id",
                "name",
                "baseUrl",
                "enabled",
                "fallbackOnly",
                "textModel",
                "visionModel",
            )
        }
        public.update(
            hasKey=bool(provider.get("apiKey")),
            models=models,
            status=self._health(child.load("provider-status", {})),
        )
        # Never reflect a gateway that echoes a credential as a model/name.
        secret = provider.get("apiKey", "")
        if secret:
            for key in ("name", "baseUrl", "textModel", "visionModel"):
                if secret in public[key]:
                    public[key] = ""
        return public

    def public_config(self):
        return dict(
            providers=[self._public_provider(p) for p in self._providers()],
            policy=self._policy(),
        )

    def configure(self, payload):
        if (
            not isinstance(payload, dict)
            or not isinstance(payload.get("providers"), list)
            or len(payload["providers"]) > 3
        ):
            raise ValueError("请分别配置三个 AI 服务来源")
        with self.lock:
            providers = {p["id"]: p for p in self._providers()}
            seen = set()
            for change in payload["providers"]:
                if (
                    not isinstance(change, dict)
                    or change.get("id") not in PROVIDER_IDS
                    or change["id"] in seen
                ):
                    raise ValueError("AI 服务编号重复或不正确")
                identity = change["id"]
                seen.add(identity)
                old = providers[identity]
                new = copy.deepcopy(old)
                if "baseUrl" in change:
                    if not isinstance(change["baseUrl"], str):
                        raise ValueError("AI 接口地址不正确")
                    new["baseUrl"] = (
                        _base_url(change["baseUrl"]) if change["baseUrl"] else ""
                    )
                credential_origin = old.get("keyOrigin") or old.get("baseUrl")
                if (
                    new.get("baseUrl")
                    and old.get("apiKey")
                    and (
                        not credential_origin
                        or _origin(credential_origin) != _origin(new["baseUrl"])
                    )
                    and ("apiKey" not in change or not change["apiKey"])
                ):
                    raise ValueError("更换接口主机时请同时填写该来源的新密钥")
                if "apiKey" in change:
                    key = change["apiKey"]
                    if (
                        not isinstance(key, str)
                        or len(key) > 500
                        or any(not 33 <= ord(c) <= 126 for c in key)
                    ):
                        raise ValueError("AI 密钥格式不正确")
                    new["apiKey"] = key
                    new["keyOrigin"] = new.get("baseUrl", "") if key else ""
                elif new.get("apiKey"):
                    new["keyOrigin"] = credential_origin or ""
                for key in ("enabled", "fallbackOnly"):
                    if key in change:
                        if type(change[key]) != bool:
                            raise ValueError("AI 服务开关必须为明确状态")
                        new[key] = change[key]
                if (
                    identity == "fallback"
                    or new.get("baseUrl")
                    and _origin(new["baseUrl"])[1] == "api.deepseek.com"
                ):
                    new["fallbackOnly"] = True
                if "name" in change:
                    if (
                        not isinstance(change["name"], str)
                        or not 1 <= len(change["name"].strip()) <= 40
                    ):
                        raise ValueError("AI 服务名称不正确")
                    new["name"] = change["name"].strip()
                for key in ("textModel", "visionModel"):
                    if key in change:
                        if (
                            not isinstance(change[key], str)
                            or change[key]
                            and not _model_id(change[key])
                        ):
                            raise ValueError("模型编号不正确")
                        new[key] = change[key]
                if "models" in change:
                    if (
                        not isinstance(change["models"], list)
                        or len(change["models"]) > 512
                    ):
                        raise ValueError("模型池不正确")
                    models = []
                    ids = set()
                    for row in change["models"]:
                        if (
                            not isinstance(row, dict)
                            or not _model_id(row.get("id"))
                            or row["id"] in ids
                            or type(row.get("enabled", True)) != bool
                            or row.get("vision", "unknown")
                            not in ("supported", "unsupported", "unknown")
                        ):
                            raise ValueError("模型池条目不正确")
                        # supported is not an administrative claim: /models
                        # metadata or an actual synthetic-image probe proves it.
                        ids.add(row["id"])
                        models.append(
                            dict(
                                id=row["id"],
                                enabled=row.get("enabled", True),
                                vision="unsupported"
                                if row.get("vision") == "unsupported"
                                else "unknown",
                            )
                        )
                    new["models"] = models
                if new["enabled"] and not new.get("baseUrl"):
                    raise ValueError("启用 AI 服务前请填写接口地址")
                providers[identity] = new
            policy = self._policy()
            if "policy" in payload:
                if not isinstance(payload["policy"], dict) or set(
                    payload["policy"]
                ) - set(DEFAULT_POLICY):
                    raise ValueError("模型切换策略不正确")
                policy.update(payload["policy"])
                limits = {
                    "maxAttempts": (6, 8),
                    "totalSeconds": (15, 180),
                    "attemptSeconds": (5, 90),
                    "fallbackReserveSeconds": (3, 30),
                }
                if (
                    any(
                        type(policy[k]) != int or not lo <= policy[k] <= hi
                        for k, (lo, hi) in limits.items()
                    )
                    or policy["fallbackReserveSeconds"] >= policy["totalSeconds"]
                ):
                    raise ValueError("模型切换次数或总时限超出范围")
            self.save(
                CONFIG_KEY,
                dict(
                    schema=CONFIG_KEY,
                    providers=[providers[i] for i in PROVIDER_IDS],
                    policy=policy,
                ),
            )
        return self.public_config()

    def refresh(self, providerId):
        provider = self._provider(providerId)
        if not provider.get("baseUrl") or not provider.get("apiKey"):
            return dict(
                ok=False,
                provider=self._public_provider(provider),
                errorCode="not_configured",
            )
        self._models(provider, force=True)
        child = self._router(provider)
        state = child.load("ai-model-catalog-status", {})
        if state.get("ok"):
            secret = provider["apiKey"]
            latest = list(
                dict.fromkeys(
                    model
                    for model in child.load("ai-model-catalog", {}).get("models", [])
                    if _model_id(model) and secret not in model
                )
            )
            with self.lock:
                providers = self._providers()
                current = next(p for p in providers if p["id"] == providerId)
                if self._router(current) is not child:
                    return dict(
                        ok=False,
                        provider=self._public_provider(current),
                        errorCode="configuration_changed",
                    )
                configured = {row["id"]: row for row in current.get("models", [])}
                current["models"] = [
                    configured.get(
                        model, dict(id=model, enabled=True, vision="unknown")
                    )
                    for model in latest
                ]
                for field in ("textModel", "visionModel"):
                    if current.get(field) not in latest:
                        current[field] = ""
                self.save(
                    CONFIG_KEY,
                    dict(schema=CONFIG_KEY, providers=providers, policy=self._policy()),
                )
                provider = current
        return dict(
            ok=state.get("ok") is True,
            provider=self._public_provider(provider),
            **({} if state.get("ok") else dict(errorCode=state.get("last_status", 0))),
        )

    def catalog(self, force=False):
        result = []
        deadline = time.monotonic() + 20
        for provider in self._providers():
            if (
                provider["enabled"]
                and provider.get("apiKey")
                and provider.get("baseUrl")
            ):
                result.extend(
                    provider["id"] + "::" + m
                    for m in self._models(provider, force, deadline)
                )
        return result

    def stats(self, vision):
        return {
            p["id"] + "::" + model: value
            for p in self._providers()
            for model, value in self._router(p).stats(vision).items()
        }

    def _candidates(
        self, provider, preferred, vision, deadline, *, refresh_catalog=True
    ):
        child = self._router(provider)
        if child.load("provider-status", {}).get("cooldown_until", 0) > time.time():
            return []
        models = self._models(provider, deadline=deadline, fetch=refresh_catalog)
        if child.load("provider-status", {}).get("cooldown_until", 0) > time.time():
            return []
        configured = {m["id"]: m for m in provider.get("models", [])}
        models = [
            m
            for m in models
            if configured.get(m, {}).get("enabled", True)
            and (not vision or self._vision(provider, m) != "unsupported")
        ]
        own_preferred = provider.get("visionModel" if vision else "textModel", "")
        if isinstance(preferred, str):
            if "::" in preferred:
                identity, model = preferred.split("::", 1)
                if identity == provider["id"] and model in models:
                    own_preferred = model
            elif preferred in models:
                own_preferred = preferred
        candidates = [
            m for m in child.candidates(own_preferred, vision, models) if m in models
        ]
        if vision:
            candidates.sort(
                key=lambda model: self._vision(provider, model) != "supported"
            )
        if vision and own_preferred in candidates:
            candidates.remove(own_preferred)
            candidates.insert(0, own_preferred)
        return candidates

    def available(self):
        return any(
            p.get("enabled") and p.get("apiKey") and p.get("baseUrl")
            for p in self._providers()
        )

    def plan_tool(self, messages, tool):
        """One short, non-streamed planning call. Never execute partial arguments."""
        for provider in self._providers():
            if not (
                provider.get("enabled")
                and provider.get("apiKey")
                and provider.get("baseUrl")
            ):
                continue
            models = self._candidates(
                provider, "", False, time.monotonic() + 4, refresh_catalog=False
            )
            if not models:
                continue
            try:
                with self._router(provider).request(
                    models[0],
                    messages,
                    160,
                    False,
                    timeout=4,
                    extra_payload={"tools": [tool], "tool_choice": "auto"},
                ) as response:
                    body = json.loads(response.read(65536))
            except (ProviderError, OSError, ValueError, http.client.HTTPException):
                return None
            choices = body.get("choices") if isinstance(body, dict) else None
            if (
                not isinstance(choices, list)
                or not choices
                or not isinstance(choices[0], dict)
            ):
                return None
            if choices[0].get("finish_reason") != "tool_calls":
                return None
            message = choices[0].get("message")
            calls = message.get("tool_calls") if isinstance(message, dict) else None
            if (
                not isinstance(calls, list)
                or len(calls) != 1
                or not isinstance(calls[0], dict)
            ):
                return None
            function = calls[0].get("function")
            if (
                not isinstance(function, dict)
                or function.get("name") != tool["function"]["name"]
            ):
                return None
            arguments = function.get("arguments")
            if isinstance(arguments, str) and len(arguments) <= 1000:
                return function
            return None
        return None

    def answer(
        self,
        messages,
        preferred,
        vision=False,
        max_tokens=1800,
        emit=None,
        validate=None,
        record_call=None,
        *,
        worksheet=False,
    ):
        policy = self._policy()
        providers = [
            p
            for p in self._providers()
            if p["enabled"] and p.get("baseUrl") and p.get("apiKey")
        ]
        pools = []
        dirty = False
        attempts = 0
        vision = bool(
            vision
            or any(
                isinstance(m.get("content"), list)
                and any(
                    isinstance(c, dict) and c.get("type") == "image_url"
                    for c in m["content"]
                )
                for m in messages
            )
        )
        if vision:
            policy["totalSeconds"] = min(
                policy["totalSeconds"], VISION_DEADLINE_SECONDS
            )
        if worksheet:
            policy.update(
                totalSeconds=VISION_DEADLINE_SECONDS
                if vision
                else min(policy["totalSeconds"], 40),
                attemptSeconds=min(policy["attemptSeconds"], 38 if vision else 30),
                maxAttempts=min(policy["maxAttempts"], 2),
                fallbackReserveSeconds=min(policy["fallbackReserveSeconds"], 4),
            )
        deadline = time.monotonic() + policy["totalSeconds"]

        def send(kind, data):
            nonlocal dirty
            if not emit:
                return
            try:
                emit(kind, data)
            except BaseException as error:
                raise _ConsumerAborted(error)
            if kind == "delta":
                dirty = True
            elif kind == "reset":
                dirty = False

        try:
            for provider in providers:
                models = (
                    self._candidates(
                        provider, preferred, vision, deadline, refresh_catalog=False
                    )
                    if worksheet
                    else self._candidates(provider, preferred, vision, deadline)
                )
                if models:
                    pools.append((provider, deque(models)))

            def score(pool):
                p, models = pool
                entry = self._router(p).stats(vision).get(models[0], {})
                recent = entry.get("recent", [])
                return (
                    -(sum(recent) + 1) / (len(recent) + 2),
                    entry.get("latency_ms", 100000),
                    PROVIDER_IDS.index(p["id"]),
                )

            main = sorted((p for p in pools if not p[0]["fallbackOnly"]), key=score)
            fallback = sorted((p for p in pools if p[0]["fallbackOnly"]), key=score)
            reserve = min(2, sum(len(q) for p, q in fallback))
            main_limit = (
                policy["maxAttempts"] - reserve if fallback else policy["maxAttempts"]
            )
            if worksheet and main:
                main_limit = min(
                    policy["maxAttempts"], sum(len(models) for _, models in main)
                )
            for phase, limit in ((main, main_limit), (fallback, policy["maxAttempts"])):
                while phase and attempts < limit:
                    provider, models = phase.pop(0)
                    child = self._router(provider)
                    if (
                        child.load("provider-status", {}).get("cooldown_until", 0)
                        > time.time()
                    ):
                        continue
                    remaining = deadline - time.monotonic()
                    reserved = (
                        policy["fallbackReserveSeconds"]
                        if phase is not fallback
                        and fallback
                        and main_limit < policy["maxAttempts"]
                        else 0
                    )
                    if remaining <= reserved + 0.05:
                        break
                    model = models.popleft()
                    if models:
                        phase.append((provider, models))
                    started = time.monotonic()
                    finish_started = vision and emit is not None
                    attempt_deadline = (
                        deadline
                        if finish_started
                        else min(
                            deadline - reserved, started + policy["attemptSeconds"]
                        )
                    )
                    ok = False
                    status = 0
                    attempts += 1
                    qualified = provider["id"] + "::" + model
                    chunks = []
                    first_text_at = None

                    def stream_output(kind, values):
                        nonlocal first_text_at
                        if kind == "delta":
                            chunk = values.get("text", "")
                            chunks.append(chunk)
                            if first_text_at is None and chunk.strip():
                                first_text_at = time.monotonic()
                        send(kind, values)

                    if dirty:
                        send("reset", {})
                    send(
                        "status",
                        dict(
                            stage="reading" if attempts == 1 else "switching",
                            text="爪爪正在认真读题，稍后一起检查思路。"
                            if attempts == 1
                            else "正在换一种方式继续分析，题目还在。",
                        ),
                    )
                    try:
                        extra = (
                            dict(thinking=dict(type="disabled"))
                            if _origin(provider["baseUrl"])[1] == "api.deepseek.com"
                            else None
                        )
                        with child.request(
                            model,
                            messages,
                            max_tokens,
                            emit is not None,
                            timeout=max(0.05, attempt_deadline - time.monotonic()),
                            extra_payload=extra,
                        ) as response:
                            reply = child.read(
                                response,
                                stream_output if emit else None,
                                deadline=attempt_deadline,
                                finish_started=finish_started,
                            )
                        if not reply.strip():
                            raise ProviderError("No content", 502)
                        if validate and not validate(reply):
                            raise ProviderError("Response validation failed", 422)
                        ok = True
                        status = 200
                        child.record(
                            model, vision, True, time.monotonic() - started, 200
                        )
                        self._record_provider(
                            provider, True, 200, time.monotonic() - started
                        )
                        return dict(
                            reply=reply, model=qualified, provider=provider["id"]
                        )
                    except ProviderError as error:
                        status = error.status
                    except TimeoutError:
                        status = 408
                    except (
                        OSError,
                        ValueError,
                        urllib.error.URLError,
                        TimeoutError,
                        http.client.HTTPException,
                    ):
                        status = 502
                    finally:
                        if record_call:
                            record_call(qualified, ok)
                    child.record(
                        model, vision, False, time.monotonic() - started, status
                    )
                    self._record_provider(
                        provider, False, status, time.monotonic() - started
                    )
                    if vision or worksheet:
                        LOG.warning(
                            "ai_attempt_failed model=%s mode=%s status=%d elapsed_ms=%d",
                            qualified,
                            "vision" if vision else "text",
                            status,
                            round((time.monotonic() - started) * 1000),
                        )
                    if finish_started and first_text_at is not None:
                        LOG.warning(
                            "ai_vision_reply_preserved model=%s first_text_ms=%d",
                            qualified,
                            round((first_text_at - started) * 1000),
                        )
                        return dict(
                            reply="".join(chunks),
                            model=qualified,
                            provider=provider["id"],
                            incomplete=True,
                        )
            if dirty:
                send("reset", {})
            raise AIUnavailable() from None
        except _ConsumerAborted as error:
            raise error.error

    @staticmethod
    def _probe_image():
        from PIL import Image, ImageDraw, ImageFont

        im = Image.new("RGB", (190, 90), "white")
        draw = ImageDraw.Draw(im)
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", 48)
        except OSError:
            font = ImageFont.load_default(size=48)
        draw.text((95, 45), "4729", fill="black", font=font, anchor="mm")
        out = io.BytesIO()
        im.save(out, "PNG")
        im.close()
        return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()

    def probe(self, providerId, vision=False, model=None):
        provider = self._provider(providerId)
        child = self._router(provider)
        if not provider.get("apiKey") or not provider.get("baseUrl"):
            return dict(
                ok=False,
                model="",
                errorCode="not_configured",
                **(dict(visionVerified=False) if vision else {}),
            )
        models = self._models(provider, fetch=False)
        configured = {m["id"]: m for m in provider.get("models", [])}
        models = [m for m in models if configured.get(m, {}).get("enabled", True)]
        if model is None:
            preferred = provider.get("visionModel" if vision else "textModel")
            model = preferred if preferred in models else next(iter(models), "")
        elif model not in models:
            return dict(ok=False, model="", errorCode="no_model", visionVerified=False)
        if not model:
            return dict(
                ok=False,
                model="",
                errorCode="no_model",
                **(dict(visionVerified=False) if vision else {}),
            )
        messages = [
            dict(
                role="user",
                content=[
                    dict(type="text", text="只回复图片中的四位数字，不要补充解释。"),
                    dict(type="image_url", image_url=dict(url=self._probe_image())),
                ]
                if vision
                else "Reply with exactly OK. This is a service availability check. No personal data.",
            )
        ]
        started = time.monotonic()
        status = 0
        ok = False
        try:
            extra = (
                dict(thinking=dict(type="disabled"))
                if _origin(provider["baseUrl"])[1] == "api.deepseek.com"
                else None
            )
            with child.request(
                model, messages, 80, False, timeout=25, extra_payload=extra
            ) as response:
                text = child.read(response, deadline=started + 25)
            ok = text.strip() == "4729" if vision else text.strip().upper() == "OK"
            status = 200 if ok else 422
        except ProviderError as error:
            status = error.status
        except (
            OSError,
            ValueError,
            urllib.error.URLError,
            TimeoutError,
            http.client.HTTPException,
        ):
            status = 502
        child.record(model, vision, ok, time.monotonic() - started, status)
        self._record_provider(provider, ok, status, time.monotonic() - started)
        if vision and ok:
            with self.lock:
                verified = child.load("ai-vision-verification", {})
                verified[model] = dict(
                    vision="supported", at=time.time(), status=status
                )
                child.save("ai-vision-verification", verified)
        result = dict(ok=ok, model=provider["id"] + "::" + model)
        if vision:
            result["visionVerified"] = ok
        if not ok:
            result["errorCode"] = status
        return result

    def probe_vision_models(self, provider_id, models):
        if (
            not isinstance(models, list)
            or not 1 <= len(models) <= 4
            or any(not _model_id(model) for model in models)
            or len(set(models)) != len(models)
        ):
            raise ValueError("每批请选择 1 到 4 个不同的模型")
        with ThreadPoolExecutor(max_workers=len(models)) as executor:
            results = list(
                executor.map(lambda model: self.probe(provider_id, True, model), models)
            )
        return dict(
            results=results, provider=self._public_provider(self._provider(provider_id))
        )

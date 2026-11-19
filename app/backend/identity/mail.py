"""QQ SMTP transport for transactional verification messages."""

import html
import re
import smtplib
import ssl
from email.message import EmailMessage
from pathlib import Path


TEMPLATE = Path(__file__).with_name("templates") / "verification-email.html"


class QQMailer:
    def __init__(self, settings, mascot, connect=smtplib.SMTP_SSL):
        self.address = settings.get("PAW_SMTP_ADDRESS", "").strip()
        self.authorization = settings.get("PAW_SMTP_AUTHORIZATION", "").strip()
        self.mascot = mascot
        self.connect = connect

    @property
    def enabled(self):
        return bool(
            self.authorization
            and re.fullmatch(r"[A-Za-z0-9._+-]+@qq\.com", self.address, re.I)
        )

    def send_code(self, address, code, *, reset, expires_minutes):
        heading = "重置账号密码" if reset else "验证伴学爪账号"
        instruction = (
            "回到伴学爪，验证邮箱后设置新密码。"
            if reset
            else "回到伴学爪，使用验证码完成账号验证。"
        )
        values = {
            "subject": heading,
            "heading": heading,
            "instruction": instruction,
            "preview_text": "伴学爪请求验证您的邮箱。",
            "code": code,
            "expiry_minutes": expires_minutes,
        }
        content = re.sub(
            r"\{\{([a-z_]+)\}\}",
            lambda match: html.escape(str(values[match[1]])),
            TEMPLATE.read_text(encoding="utf-8"),
        )
        message = EmailMessage()
        message["From"] = f"伴学爪 <{self.address}>"
        message["To"] = address
        message["Subject"] = f"伴学爪 · {heading}"
        message.set_content(
            f"{heading}\n验证码：{code}。{expires_minutes} 分钟内有效。\n如果这不是您的操作，可以忽略此邮件。"
        )
        message.add_alternative(content, subtype="html")
        message.get_payload()[-1].add_related(
            self.mascot.read_bytes(),
            maintype="image",
            subtype="png",
            cid="<paw-mascot>",
            disposition="inline",
        )
        with self.connect(
            "smtp.qq.com", 465, timeout=10, context=ssl.create_default_context()
        ) as smtp:
            smtp.login(self.address, self.authorization)
            smtp.send_message(message)

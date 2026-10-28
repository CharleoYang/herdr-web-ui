"""S2-R receipt: an independent review recorded a verdict against the design docs."""
from pathlib import Path
import sys

path = Path("spec/001-chat-realtime/[设计评审]-chat-realtime.md")
if not path.is_file():
    sys.exit("review file absent")
text = path.read_text(encoding="utf-8")
required = ("PASS", "FAIL", "conversation-delta", "prompt-push", "[设计文档]-chat-realtime.md", "[接口文档]-chat-realtime.md")
missing = [item for item in required if item not in text]
if "PASS" in text and "FAIL" in text and "结论" not in text:
    missing.append("结论")
if len(text.strip()) < 200:
    missing.append("too short")
if missing:
    sys.exit("review missing: " + ", ".join(missing))
print("s2r-review-ok")

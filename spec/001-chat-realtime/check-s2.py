"""S2 receipt: design, interface and class docs exist and name the realtime contract."""
from pathlib import Path
import sys

root = Path("spec/001-chat-realtime")
required = {
    "[设计文档]-chat-realtime.md": ("conversation-delta", "prompt-push", "REST", "INVALIDATION_MS"),
    "[接口文档]-chat-realtime.md": ("conversation-delta", "prompt-push", "conversation-changed", "ServerFeature"),
    "[类图]-chat-realtime.md": ("ConversationRefresh", "ChatView", "ConversationMonitor"),
    "context-report.md": ("conversationRefresh.ts", "ChatView.tsx", "protocol.ts"),
}
missing = []
for name, needles in required.items():
    path = root / name
    if not path.is_file():
        missing.append(name + " absent")
        continue
    text = path.read_text(encoding="utf-8")
    if len(text.strip()) < 80:
        missing.append(name + " empty")
        continue
    absent = [needle for needle in needles if needle not in text]
    if absent:
        missing.append(name + " missing " + ",".join(absent))
if missing:
    sys.exit("S2 docs: " + "; ".join(missing))
print("s2-design-ok")

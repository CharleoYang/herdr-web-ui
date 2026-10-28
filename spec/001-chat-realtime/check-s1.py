"""S1 receipt: FEATURE.md states the realtime contract and its non-goals."""
from pathlib import Path
import sys

path = Path("spec/001-chat-realtime/FEATURE.md")
text = path.read_text(encoding="utf-8")
required = (
    "## Intent",
    "## Scope",
    "## Acceptance criteria",
    "conversation-delta",
    "prompt-push",
    "INVALIDATION_MS",
    "PROMPT_POLL_MS",
    "Electron",
    "WebGL",
    "push-contract",
    "client-refresh",
    "server/conversation-push.contract.test.ts",
    "src/lib/ws.test.ts",
)
missing = [item for item in required if item not in text]
if missing:
    sys.exit("FEATURE.md missing: " + ", ".join(missing))
intent = text.split("## Scope", 1)[0].split("## Intent", 1)[-1].strip()
if len(intent) < 40:
    sys.exit("FEATURE.md Intent is empty")
print("s1-feature-ok")

"""S4 receipt: the frozen task table still matches the signed page-replacement contract."""
from pathlib import Path
import sys

task = Path("spec/001-chat-realtime/task.md").read_text(encoding="utf-8")
design = Path("spec/001-chat-realtime/[设计文档]-chat-realtime.md").read_text(encoding="utf-8")
required_task = ("T-01", "T-02", "T-03", "T-04", "T-05", "conversation-delta", "prompt-push")
required_design = ("整页", "256 KiB", "ConversationMonitor", "BACKSTOP_MS")
missing = [item for item in required_task if item not in task]
missing += [item for item in required_design if item not in design]
if "T-02,T-03,T-04" not in task.replace(" ", ""):
    missing.append("T-05 deps")
if missing:
    sys.exit("s4 plan drift: " + ", ".join(missing))
print("s4-plan-ok")

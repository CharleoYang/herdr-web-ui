# T-04 R1–R3 retrospective and revised readiness/provenance contract

## Decision and authority

Ordinary iteration stopped after logical R3. No candidate has release approval. Under the user's delegated design/integration authority (FEATURE.md; no Main-flow validation), Main records this retrospective before authorizing any exceptional R4. R4 remains round 4, not a reset via a new task or feature cycle. Existing requirements and real-browser gates remain unchanged. A source-derived race is not represented as a reproduced runtime failure.

## Complete observed rounds

| Round | Source verdict | Independently measured QA | Findings, category and cost |
| --- | --- | --- | --- |
| R1 | FAIL, P1 remote watch plan content/path disclosure, `server/index.ts:626-627` in `/tmp/spec-001-chat-realtime-review-prompt` | 107/0; typecheck 3 TS2769; build pass; browser 14/17, with additional privacy/race/answer paths unexercised | Authorization provenance crossed the relay; role=observe was mistaken for file-read restriction. New test envelope assertions did not compile. DOM/capability setup did not establish consumer-visible acceptance. Security false-negative risk and legitimate release refusal. |
| R2 | Whole-source PASS for immutable reduction-only relay policy | 107/1; typecheck/build pass; browser 18/23 | Authentication prerequisite absent in the new token-bearing owner socket, so eight-case matrix never reached policy assertions. Collapse used hidden-child boxes as an oracle; offline did not prove disconnect; line-buffered fixture did not prove key delivery. Optional telemetry/fixture 404s were incompletely classified. Test-authoring failure, false-rejection risks and unproven transitions; no release PASS. |
| R3 | FAIL, P2 first-frame enrichment assumption, `/tmp/spec-001-chat-realtime-review-prompt-r3/server/conversation-push.contract.test.ts:798-850` | 108/0; typecheck/build pass; browser 23/26, three plan gates NOT MEASURED | Native session discovery is asynchronous and snapshots deliberately do not wait for it. First screen-only plan may legitimately precede file enrichment. This is source-derived; QA's green run does not disprove it. Browser owned plan oracle returned null, so plan rendering and owner/reduced parity were not exercised. R3 fixed actual collapse, reconnect and key delivery evidence without weakening those gates. |

Evidence: `/tmp/chat-realtime-t04-source-review{,-r2,-r3}.md`; `/tmp/chat-realtime-qa-prompt-mcli{,-r2,-r3}/report.md`. Frozen candidate digests and all earlier outcomes remain in `review-history.md`. R3 browser additionally records harness failures for shell quoting, wrong native read envelope, narrow-pane wrapping and missing ffmpeg revision; their identities/logs remain in its report. These setup attempts are not independent passing product runs.

## Why each repair fixed an instance rather than the class

1. **Authorization and mode were modeled at the wrong boundary.** R1 reasoned from a local socket's readOnly field, not the originating device through an owner-authenticated relay. R2 correctly moved the restriction before the read, but the new matrix still lacked a complete executable setup contract.
2. **Expected values preceded prerequisites.** R2 repaired types, then R3 credentials and native screen/session construction. Neither review modeled discovery readiness separately from socket readiness. A snapshot, input-ready or role ACK is not a transcript-tracker-ready receipt. The first prompt therefore cannot be required to contain file enrichment without a separate observed readiness barrier.
3. **QA copied a recipe, not the dependency graph.** A real file and terminal footer are necessary but do not prove that the bridge read the intended pane/session/config. R3 browser's null oracle remains an unresolved fixture setup gap; do not invent a product defect or a successful plan gate from it.
4. **Visible invariants were repeatedly replaced by implementation details.** Node removal then child layout size both misjudged collapsed native details. R3 finally measured real click, open=false, smaller panel and unpainted content. The general rule is visible behavior, not a preferred DOM implementation.
5. **Fault and delivery controls were not independently observed.** Offline toggling and HTTP answer success were mistaken for socket closure and PTY delivery. R3 established new handshake/snapshot plus REST, and captured actual input byte `1`; these must remain required on subsequent full candidates.
6. **Provenance itself was not pinned for every explanatory claim.** After R3, QA's read-only comparison mistakenly described the earlier mocked fixture as the green R3 fixture. Main read all three exact R3 files and hashed them: author, QA and reviewer contract test each SHA256 `8048a9f831c3813ebb26482d25d3e0bd65871801ce72a9dbddade23a2b91fb13`. R3 lines 755-805 create the real native process and reader; only the named machine endpoint is substituted. The injection-versus-discovery explanation is false for R3 and cannot be used as its root cause. Correction requested; retain both claim and correction.

## Revised contract: state transitions before value assertions

### Invariants and authoritative oracle

- Every authenticated full/observe-owner local or relay reader retains permitted real plan file content/path. A watch credential or explicit plan=0 never receives either, regardless of later terminal-role frames. Watch caller plan=1 is the escalation-negative control; full/observe owners are the over-restriction-negative controls.
- Before file-enrichment readiness, an authoritative screen-only plan is legitimate. Do not change production snapshot/prompt timing to satisfy the test and do not reject it as a privacy or delivery failure.
- The authoritative oracle is the actual authenticated `GET /api/pane/prompt` from the very bridge/pane/policy being tested, backed by the real native reader and private test files. No fabricated API payload, snapshot metadata, session path, screen read or forced plan success may replace this chain.
- First prove full-owner enrichment readiness independently on the connection bridge and private upstream. Await the real owner HTTP result with expected kind=plan, actual private path and unique file-only body marker. Use bounded condition polling, never a fixed sleep or snapshot/attach ACK as readiness. Failure names the bridge and last observed state as setup failure; it is not a redaction verdict.
- Only after those barriers, enable the policy-specific WS interest and compare its initial frame to its same-policy REST oracle while screen/transcript/file inputs stay stable. Keep the actual eight local/relay × owner/observe/watch/reduced combinations and all credential/precondition checks.
- A browser plan gate starts only after its actual bridge's owner oracle is enriched and its native pane is the intended Claude process/session. A footer observed through whitespace normalization alone is not sufficient evidence that the authoritative parser recognizes the actual screen.

### Fixture provenance receipt

Record absolute candidate/import roots, source file hashes, native socket/session, bridge port, pane ID/agent/state/session ID, actual detection-screen dimensions/text and transcript/config/private-plan paths. Observe the real bridge reader; do not dump production credentials. Keep bridge-process HOME/config separate from pane-process HOME/config, and verify the resolver's actual input provenance rather than assuming the environment was inherited. Use an owned fresh workspace with stable 80-column-or-wider geometry, as in the real native contract fixture; avoid split/zoom and competing fixture reports until equivalent resolution is proven. Stable dimensions are a fixture input, not a production UI restriction.

### Adversarial matrix and error taxonomy

| Dimension | Required controls | Verdict boundary |
| --- | --- | --- |
| Readiness | Missing/resolving enrichment must remain a legitimate screen-only state; ready state established per actual bridge before enriched assertions | Never infer readiness from snapshot, ACK or time elapsed |
| Privilege | Owner and observe-owner retain file content/path; watch with plan=1 and owner with plan=0 exclude both | No role-based widening, no blanket over-restriction |
| Transport | Local and real machine relay, actual endpoint Bearer authentication | Source cookie is not the upstream credential |
| Lifecycle | Existing initial/null/change/dedup, reinterest, reconnect, hidden restore and delayed real REST controls | Readiness warmup cannot disable stale-result or first-interest checks |
| Presentation/input | Real expanded/collapsed panel/scroll/mobile, actual plan card, real socket close and captured answer byte | No DOM-incidental oracle, fake transition or HTTP-only delivery claim |
| Errors | Authentication/setup, enrichment not ready, policy mismatch, product transition failure, classified fixture resources | Keep UNKNOWN/NOT MEASURED distinct from FAIL and PASS |

## Exceptional continuation and acceptance

This artifact is the prerequisite, not R4 authorization by itself. Main may explicitly authorize the existing author to repair only test readiness and provide a source-grounded real-native fixture diagnostic/recipe. No business-code change is justified by current evidence. Preserve existing candidate/report history and exact native task/lease lineage. QA owns its harness corrections and must first validate the provenance chain, not repeatedly run the entire matrix with a null plan oracle.

Then require a newly frozen candidate, whole-candidate source review and independent mcli full focused/type/build/real-browser acceptance. R3's 23 measured gates are checkpoints, not a waiver: rerun all 26 plus required watch/relay controls, report a single consistent tally and retain screenshots/video/network/console. Main still runs no validation. If the new readiness design fails to establish the oracle, stop and report the exact missing prerequisite; do not broaden scope, fake data, silently lower a gate or reset the review counter.

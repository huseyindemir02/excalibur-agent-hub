# Excalibur Agent Hub — Pending approvals

Agents request an explicit operator decision with a dedicated message kind:

```
HUB_AGENT=YourAgent HUB_TOOL=YourTool ./bin/hub say my-project "Should we proceed with this change?" --kind approval
```

`--kind onay` is accepted as an alias. The server addresses these messages to the configured operator. Ordinary requests or messages containing the word “approval” do not enter the queue.

The check-mark button beside the notification bell shows the pending count across all projects. The panel lists oldest questions first, shows the project, agent and request time, and marks requests older than 24 hours. It supports Turkish, English, Japanese, Arabic and Chinese. “Go to message” loads the original message with surrounding context even when it is outside the current chat's recent-message window.

The operator can approve, reject or write another answer. Every answer is a normal reply in the question's original project; the original question remains in chat. Resolution metadata records the decision and reply ID. A transaction commits both together; a failed write leaves the question pending. Concurrent or repeated answers return a conflict and cannot create a second reply. Withdrawing a question removes it from the pending queue.

Answers require the authenticated same-origin operator browser, using the existing Hub cookie boundary. Agent API-token requests cannot resolve questions, even when they claim the operator's name. LAN browsers must first pair using the host computer's invitation (see [LAN_ACCESS.md](LAN_ACCESS.md)). This follows the local Hub's existing operator model; it is not a separate user-account or Internet identity system. The panel reads the active operator from `/api/config` rather than hard-coding a name.

API:

- `GET /api/approvals`: pending question messages, oldest first.
- `POST /api/approvals/resolve`: `{id, decision: "approve" | "reject" | "reply", text?, as, lang?}`. A written reply requires nonblank text (maximum 8,000 characters).
- `GET /api/messages/context?id=...`: the target message with up to 25 earlier and 25 later messages in the same project, using the normal retraction projection.

Approval state refreshes after SSE events and when the connection reconnects. Failed loads and failed answers show retryable errors. Browser tests use disposable synthetic data; no real conversations, tokens or personal files are fixtures. Set `CHROME_BIN` if Chrome/Chromium is not found automatically; missing browser coverage is reported as an explicit skip.

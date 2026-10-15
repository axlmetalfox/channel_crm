# cost-sim — conversation simulator for measuring LLM cost

`sim.py` plays scripted customer conversations against the AI gateway using
the exact system-prompt scaffold TUYO CRM builds (auto-reply mode, hand-off
off), and prints the gateway's `credits_charged` per turn and per
conversation. Use it to measure the cost of an agent prompt before it meets
real customers, and to run the interview-block protocol in
`docs/producto/medicion-de-costos.md`.

```bash
ROUTER_KEY=sk-hstgr-... python sim.py path/to/prompt.txt A   # scenario A, B, C, D or all
```

- The key is read from the environment; never commit it.
- The gateway rejects Python's default User-Agent, so the script sends a
  curl-like one.
- The scenarios and the canned customer answers are written for the Intertec
  lead-capture flow. For another agent, edit `answer_for` and the scenarios.
- It keeps the scaffold text in sync by hand with `buildSystemPrompt` in
  `src/lib/ai/defaults.ts`; update it if that changes.

# AGENTS.md

penguin-remote：飞书机器人 ⇄ PenguinHarness 桥接程序。总体设计与决策见 `PLAN.md`（唯一事实来源），领域词汇见 `GLOSSARY.md`，架构决策见 `docs/adr/`。

## Agent skills

### Issue tracker

GitHub Issues in this repo (`gh` CLI; repo `smallrespon/penguin-remote`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

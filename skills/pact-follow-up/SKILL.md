---
name: pact-follow-up
description: Configure and run follow-up nudges for overdue commitments.
triggers:
  - follow up
  - nudge
  - remind
  - overdue
  - escalate
tools:
  - bash
---

# Pact Follow-Up -- Nudge Overdue Commitments

## Preview what would be nudged

```bash
pact follow-up --dry-run
```

## Send nudges to terminal

```bash
pact follow-up --via stdout
```

## Send nudges via Slack DM

```bash
pact follow-up --via slack-dm
```

## Configure behavior

```bash
pact follow-up --via slack-dm \
  --grace-period 4h \
  --max-nudges 3 \
  --cooldown 24h \
  --escalate-after 3 \
  --escalate-to "slack:#engineering"
```

## JSON output

```bash
pact follow-up --json
```

## Run as cron (recommended)

Add to crontab: `*/15 9-18 * * 1-5 pact follow-up --via stdout`

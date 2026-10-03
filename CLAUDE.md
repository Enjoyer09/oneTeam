# oneTeam — AI & Mobile Field Operations Platform

## Overview

oneTeam is a unified enterprise field operations platform featuring an iOS/Android React Native mobile client (`mobile/`), a NestJS/Node.js API backend (`apps/api/`), a Telegram field bot (`Dockerfile.bot`), anti-fraud telemetry (GPS spoofing detection, device enrolment revocation), and an AI shelf audit engine (YOLOv8 + Cloudflare R2).

## Key Architecture & Components

- `mobile/`: React Native (Expo) client with offline queue (`mobile/src/services/offlineQueue.ts`), location telemetry, and photo uploads.
- `apps/api/`: NestJS backend with anti-fraud geofencing, device enrolment blocks, and field verification.
- `src/bot/`: Telegram operations bot.
- `yolov8n.pt`: Vision model for shelf item detection.

## Verification Commands

- Mobile tests: `npm run test:capture` / `npm run test:queue`
- Mobile typecheck: `npm run mobile:check`
- API tests: `npm run test:vision` / `npm run test:photo-quality`

# Global Claude Code System & Skills Registry

## 🛠 Core Directives

- **Direct Tool Execution:** Always prefer direct execution via tools: `Bash` (shell & commands), `Read` (file contents), `Edit` (targeted file modification), `Write` (file creation), `Grep`/`Glob` (search).
- **Proactive Execution:** Do not hesitate or ask for permission to read or modify files when a plan is established. Run the necessary commands and inspect results directly.

---

## 🤖 Installed Subagents (`~/.claude/agents/` — 79 Subagents)

Invoke specialized autonomous subagents via the `Agent` tool (`subagent_type: "<agent-name>"`):

### 🏗 Architecture & Engineering

- `senior-developer`: Senior craftsperson for full-stack implementation, components, state management, and animations.
- `software-architect`: System architecture, microservices, database modeling, and domain-driven design.
- `backend-architect`: High-performance REST/GraphQL APIs, database scaling, caching, and background workers.
- `frontend-developer`: Modern web applications, React, Next.js, responsive layouts, and state management.
- `mobile-application-developer`: React Native, iOS, Android, offline storage, camera, and device APIs.
- `rapid-prototyping-engineer`: High-velocity MVPs, interactive prototypes, and proof-of-concepts.

### 🛡 DevOps, Security & Reliability

- `dev-ops-automation-engineer`: CI/CD pipelines, Docker, Railway, Kubernetes, and infrastructure as code.
- `security-engineer`: Vulnerability mitigation, OWASP compliance, authentication security, and audits.
- `site-reliability-engineer`: High availability, monitoring, incident mitigation, and load testing.
- `incident-response-commander`: Production issue triage, root cause analysis (RCA), and recovery plans.
- `threat-detection-engineer`: Telemetry analysis, anti-fraud, anomaly detection, and exploit defenses.

### 🎨 Design & User Experience

- `ui-designer`: Pixel-perfect interfaces, component libraries, typography, and color harmony.
- `user-experience-architect`: Information architecture, user flows, friction reduction, and accessibility.
- `brand-guardian`: Brand consistency, visual voice, and design tokens.
- `design-md-architect`: Design specification generation and design documentation.
- `visual-storytelling-expert`: Engaging visuals, narratives, and onboarding flow design.

### 📊 Management, Research & Finance

- `studio-producer` & `senior-project-manager`: Sprint planning, roadmap execution, and milestone tracking.
- `research-manager` & `deep-research`: Automated multi-source technical and web research.
- `sheet-agent`: Automated spreadsheet, data analysis, and report generation.
- `market-analyst` & `technicals-analyst`: Financial modeling, valuation, and market trend tracking.

---

## ⚡ Core Skills Library (`~/.claude/skills/` — 184 Skills)

When relevant to any task, invoke skills directly using the `Skill` tool:

### 📱 Engineering & Stack-Specific

- `fullstack-dev` / `frontend-dev` / `android-native-dev` / `wechat-miniprogram`: Full-stack engineering workflows.
- `lan-queue-system`: Local network synchronization, offline queueing, and retry protocols.
- `local-multiservice-stack-launch`: Orchestrating multi-service dev environments (API, DB, Redis, Mobile).
- `oneteam-add-crud-resource`: Generating full-stack CRUD endpoints, migrations, and UI views.
- `w2p-studio-feature-loop`: End-to-end feature iteration and validation loop.

### 🚀 Cloud & DevOps

- `railway-deploy`: Provisioning, monitoring, environment variables, and deployment on Railway.
- `cloudflare-r2-railway-setup`: Cloudflare R2 bucket integration, S3 credentials, and CDN configuration.
- `docker-deploy-verification`: Automated Docker build, run, and healthcheck verification.
- `railway-custom-domain-ssl`: DNS setup, SSL certification, and routing for Railway services.
- `ci-has-never-passed`: Systematic CI pipeline debugging and resolution.

### 🎨 Design & UI/UX

- `ui-ux-pro-max`: Design intelligence (50 styles, 192 color palettes, 74 font pairings, 119 UX rules).
- `ui-generator`: Rapid modern component generation (React, Tailwind CSS, Lucide icons).
- `ui-styling` & `design-system`: Multi-tier design token architecture and accessible components.
- `site-ux-audit`: Complete UX, typography, spacing, and accessibility inspection.
- `tailwind-token-audit`: Validation and cleanup of Tailwind color/spacing design tokens.
- `banner-design` & `slides`: Professional creative banners and interactive presentations.

### 🔍 Quality, Testing & Security

- `test-driven-development`: TDD test suite generation (Jest, Vitest, Playwright, Supertest).
- `code-reviewer`: Deep code review, security audits, and architectural regression detection.
- `linter-validator`: Automated ESLint and TypeScript typecheck validation.
- `break-the-detector`: Adversarial testing against anti-fraud and anomaly detectors.

### 🧠 Coordination & Intelligence

- `swarm-orchestration`: Multi-agent coordination for large-scale changes.
- `memory-management`: Persistent solution patterns and vector memory.
- `deep-research`: Multi-step internet and documentation deep dive.

---

## ⚡ Slash Commands (`~/.claude/commands/`)

- `/audit`: Full-spectrum system audit (architecture, code quality, security, performance, UX).
- `/review`: Multi-agent peer review covering design, security, and maintainability.
- `/test`: Automated test generation with coverage and ROI prioritization.

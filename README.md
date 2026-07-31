# AutoSRE Agent v3

[![Node.js](https://img.shields.io/badge/Node.js-18.x-green.svg?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.x-38B2AC.svg?style=for-the-badge&logo=tailwind-css)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

**AutoSRE** is an AI-powered DevOps Agent simulation that autonomously diagnoses and resolves server incidents. This project demonstrates a clean architecture approach, rigorous backend design, and a modern Matrix-style hacker UI using Tailwind CSS. 

With **V3 Advanced Features**, the agent now operates with enterprise-grade safety, async execution queues, and chaos engineering triggers.

## 🚀 Built With

- **Backend Architecture**: Node.js & Express using a Clean Architecture paradigm (Services, Controllers, Robust Error Middleware).
- **Frontend Design System**: Tailwind CSS (CDN) with glassmorphism effects, interactive approvals, and custom animations.
- **Real-time Communication**: Server-Sent Events (SSE) for seamless, low-latency streaming of the Agent's ReAct (Reason+Act) processes.

## 🌟 V3 Upgrades

1. **Async ReAct Execution Queue + SSE Thought Streaming**: The backend agent loop evaluates a queued plan of thoughts and actions asynchronously, safely communicating updates via SSE and supporting intermittent pauses.
2. **Safe Whitelisted Commands Sandbox**: Security guardrail. Actions evaluated by the ReAct loop are strictly executed against an isolated `CommandSandbox` that verifies actions against an immutable whitelist.
3. **Human-In-The-Loop (HITL) Validation**: Before any action modifies the system, the agent halts and prompts the operator. UI provides dynamic "Approve" / "Reject" controls integrated with a state machine to resume or kill the agent.
4. **Chaos Engineering Trigger**: Intentionally inject severe production failures via the `/api/chaos` endpoint to test the agent's incident response in a safe, contained environment.

## 🚢 V4 Upgrades (Enterprise Grade)

1. **Kubernetes Orchestration (`k8s/`)**: Fully declarative configurations including Deployments (with resource limits and health probes), Services, and Ingress routing via NGINX.
2. **CI/CD Pipelines (`.github/workflows/`)**: Automated GitHub Actions workflow to validate Node.js builds, run unit tests, and perform simulated Docker container builds on every push/PR to main.
3. **Swagger API Documentation (`/api-docs`)**: Interactive OpenAPI 3.0 specification exposed via Swagger UI for developers and SREs to explore the agent control plane endpoints.

## 📐 Architecture Diagram

```mermaid
graph TD
    Client[Client UI (Tailwind Matrix Theme)] -->|HTTP GET /api/state| StateCtrl[State Controller]
    Client -->|HTTP POST /api/chaos| StateCtrl
    Client -->|HTTP POST /api/reset| StateCtrl
    Client -->|SSE /api/agent| AgentCtrl[Agent Controller]
    Client -->|HTTP POST /api/agent/approve| AgentCtrl
    
    StateCtrl --> StateSvc[State Service]
    AgentCtrl --> StateSvc
    AgentCtrl --> Sandbox[Command Sandbox Validator]
    Sandbox -.->|Validates Actions| StateSvc
    
    StateSvc --> Data[(In-Memory Server State)]
    
    AgentCtrl -->|Streams Thought/Action/Observation/Approval| Client
```

## 🧠 Why & Trade-offs

- **Clean Architecture**: By separating logic into `StateService`, `StateController`, and `AgentController`, the system is highly testable and extensible. 
- **Tailwind CSS CDN**: Chosen for rapid prototyping without a build step, while still offering the complete utility-first framework for a cohesive design system.
- **Server-Sent Events (SSE)**: Selected over WebSockets because the agent execution is essentially unidirectional streaming (Server -> Client), making SSE the most lightweight and native solution for this use case. Pauses for approvals are handled out-of-band via REST `POST` endpoints to resume the async promise.
- **In-Memory State**: For this simulation, persistence is not required. State is kept in-memory for speed and simplicity.

## ⚡ Quick Start

1. **Clone the repository** (if not already local).
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Start the server**:
   ```bash
   npm start
   ```
4. **Open in browser**:
   Navigate to [http://localhost:4002](http://localhost:4002).

## 🛡️ Rigorous Engineering

- **Zero Unused Variables**: Codebase rigorously checked.
- **JSDoc Typings**: Complete type annotations on the backend for developer experience and reliability.
- **Global Error Handling**: Express error middleware guarantees no unhandled promise rejections bring the server down.
- **Circuit Breaker Pattern**: The agent is wrapped in an execution circuit breaker to ensure failures do not cause widespread impact.

---

> _"There is no spoon... only automated incident resolution."_

# AutoSRE Agent

[![Node.js](https://img.shields.io/badge/Node.js-18.x-green.svg?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3.x-38B2AC.svg?style=for-the-badge&logo=tailwind-css)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

**AutoSRE** is an AI-powered DevOps Agent simulation that autonomously diagnoses and resolves server incidents. This project demonstrates a clean architecture approach, rigorous backend design, and a modern Matrix-style hacker UI using Tailwind CSS.

## 🚀 Built With

- **Backend Architecture**: Node.js & Express using a Clean Architecture paradigm (Services, Controllers, Robust Error Middleware).
- **Frontend Design System**: Tailwind CSS (CDN) with glassmorphism effects and custom animations.
- **Real-time Communication**: Server-Sent Events (SSE) for seamless, low-latency streaming of the Agent's thought processes.

## 📐 Architecture Diagram

```mermaid
graph TD
    Client[Client UI (Tailwind Matrix Theme)] -->|HTTP GET /api/state| StateCtrl[State Controller]
    Client -->|HTTP POST /api/reset| StateCtrl
    Client -->|SSE /api/agent| AgentCtrl[Agent Controller]
    
    StateCtrl --> StateSvc[State Service]
    AgentCtrl --> StateSvc
    
    StateSvc --> Data[(In-Memory Server State)]
    
    AgentCtrl -->|Streams Thought/Action/Observation| Client
```

## 🧠 Why & Trade-offs

- **Clean Architecture**: By separating logic into `StateService`, `StateController`, and `AgentController`, the system is highly testable and extensible. 
- **Tailwind CSS CDN**: Chosen for rapid prototyping without a build step, while still offering the complete utility-first framework for a cohesive design system.
- **Server-Sent Events (SSE)**: Selected over WebSockets because the agent execution is essentially unidirectional streaming (Server -> Client), making SSE the most lightweight and native solution for this use case.
- **In-Memory State**: For this simulation, persistence is not required. State is kept in-memory for speed and simplicity, though it resets on server restart.

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

---

> _"There is no spoon... only automated incident resolution."_

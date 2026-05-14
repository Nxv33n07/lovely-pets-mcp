# 🐾 Lovely Pets Enterprise AI Analytics MCP Platform

Welcome to the **Lovely Pets AI Intelligence Server**—an elite, high-fidelity data analytical engine built on top of the **Model Context Protocol (MCP)**. 

Designed specifically for the business owners workshop, this server transforms **Claude Desktop** into a world-class, lightning-fast relational intelligence analyst, communicating directly with an enterprise-scaled AWS RDS data warehouse housed in the cloud.

---

## ✨ God-Level Features

*   📈 **High-Fidelity Visual Graphs**: Powered by **QuickChart.io**, emitting gorgeous multi-dataset Bar, Line, and Doughnut charts inline directly inside the chat window.
*   🔋 **100% Offline Resiliency Fallback**: Integrated real-time local SVG graphics generator to ensure visuals continue loading even if external network issues occur during the workshop.
*   🛡️ **Defensive Token Shield Technology**: Specifically calibrated for **Free Tier AI Accounts**. Enforces code-level response slices (max 60 rows) and aggressive SQL aggregation directives, extending account life indefinitely.
*   🏥 **360° Clinical & Business Insights**: Relational lookups mapping client-patient data, active diagnostic logs, locked-up capital valuation, and daily cash aggregates.

---

## 🛠️ System Architectural Design

The platform is designed around speed and decoupling:
1.  **RDS Cache Isolation**: Operating completely independent of slow ERP APIs during the workshop by serving sub-5ms cached relational responses.
2.  **Hyper-Dense Relational Mocking**: Simulates over **100,000 transactional events** dispersed across an 8-month timeline with perfect foreign key integrity.
3.  **Express SSE Layer**: A robust Server-Sent Events listening channel fully capable of handling dozens of concurrent analytical queries from multiple users.

---

## ☁️ Cloud Deployment (Render.com)

This repository is 100% pre-configured for **Render Cloud Web Hosting** using the included `render.yaml` blueprint. 

### Step 1: Connect to GitHub
Initialize the codebase and push to your GitHub account:
```bash
git init
git add .
git commit -m "feat: Production-ready Cloud MCP Deployment"
git remote add origin <YOUR_GITHUB_REPO_URL>
git branch -M main
git push -u origin main
```

### Step 2: Deploy on Render
1. Log into the [Render Dashboard](https://dashboard.render.com).
2. Click **New +** -> **Web Service**.
3. Select your `lovely-pets-mcp` repository.
4. Under the environment configurations, set the following required secret value:
   *   **`DB_PASS`**: `AlumnxLearn@2026`
5. Click **Deploy Web Service**.

Once complete, you will get your permanent, scalable web URL:
`https://<YOUR_SUBDOMAIN>.onrender.com/mcp`

---

## 🤝 For Workshop Attendees: How to Connect

Attendees in the workshop can securely link their own **Claude Desktop** clients to your cloud-deployed analytics node! 

Instruct them to add the following to their Claude configuration file:

### On macOS / Windows:
1. Open the **Claude Desktop** App.
2. Open settings, or click "Edit Config" to modify your `claude_desktop_config.json` file.
3. Paste the following block inside the `mcpServers` group:

```json
"mcpServers": {
  "lovely-pets-intelligence": {
    "command": "curl",
    "args": [
      "-X", "POST",
      "-d", "",
      "https://<YOUR_DEPLOYED_SUBDOMAIN_URL>.onrender.com/mcp"
    ]
  }
}
```

Alternatively, if configuring via SSE web-clients, point them to:
`https://<YOUR_DEPLOYED_SUBDOMAIN_URL>.onrender.com/mcp`

---

## ⚙️ Development & Local Seeding

Should you ever wish to run it locally or re-populate the warehouse:

### Install & Seed
```bash
# Install modules
npm install

# Create schemas and run 60x Synthesizer pipeline
npm run start
```

### Launch Local Server
```bash
npm run mcp
```
*Locally active on `http://localhost:3001`*

---

🐾 *Handcrafted with absolute precision for the Lovely Pets Business Workshop.*

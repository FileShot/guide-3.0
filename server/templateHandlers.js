/**
 * Project Templates — Template listing, creation, and scaffolding.
 * Provides REST endpoints for the frontend's NewProjectDialog.
 */
'use strict';

const path = require('path');
const fs = require('fs').promises;

// ─── Template Definitions ────────────────────────────────────────────
const TEMPLATES = [
  {
    id: 'blank-project',
    name: 'Blank Project',
    description: 'An empty project folder with just a README',
    icon: 'folder',
    category: 'general',
    tags: ['empty', 'blank', 'scratch'],
    files: {
      'README.md': '# {{PROJECT_NAME}}\n\nA fresh project. Start building!\n',
    },
  },
  {
    id: 'react-ts-vite',
    name: 'React + TypeScript',
    description: 'Modern React app with TypeScript, Vite, and Tailwind CSS',
    icon: 'react',
    category: 'frontend',
    tags: ['react', 'typescript', 'vite', 'tailwind'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', private: true, version: '0.1.0', type: 'module',
        scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' },
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
        devDependencies: { '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0', '@vitejs/plugin-react': '^4.3.0', autoprefixer: '^10.4.20', postcss: '^8.4.49', tailwindcss: '^3.4.17', typescript: '^5.6.0', vite: '^6.0.0' },
      }, null, 2),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'ES2020', useDefineForClassFields: true, lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true, isolatedModules: true, moduleDetection: 'force', noEmit: true, jsx: 'react-jsx', strict: true, noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, baseUrl: '.', paths: { '@/*': ['src/*'] } },
        include: ['src'],
      }, null, 2),
      'vite.config.ts': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport path from 'path';\n\nexport default defineConfig({\n  plugins: [react()],\n  resolve: {\n    alias: { '@': path.resolve(__dirname, './src') },\n  },\n});\n`,
      'tailwind.config.js': `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],\n  theme: { extend: {} },\n  plugins: [],\n};\n`,
      'postcss.config.js': `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`,
      'index.html': `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>{{PROJECT_NAME}}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
      'src/main.tsx': `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
      'src/App.tsx': `import { useState } from 'react';\n\nfunction App() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">\n      <div className="text-center space-y-6">\n        <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">\n          {{PROJECT_NAME}}\n        </h1>\n        <p className="text-gray-400">Built with React + TypeScript + Vite + Tailwind</p>\n        <button\n          onClick={() => setCount(c => c + 1)}\n          className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors"\n        >\n          Count: {count}\n        </button>\n      </div>\n    </div>\n  );\n}\n\nexport default App;\n`,
      'src/index.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
      '.gitignore': 'node_modules\ndist\n.env\n.env.local\n',
      'README.md': '# {{PROJECT_NAME}}\n\nReact + TypeScript project scaffolded by guIDE.\n\n## Getting Started\n\n```bash\nnpm install\nnpm run dev\n```\n\nOpen [http://localhost:5173](http://localhost:5173) in your browser.\n',
    },
  },
  {
    id: 'nextjs-app',
    name: 'Next.js App Router',
    description: 'Next.js 15 with App Router, TypeScript, and Tailwind CSS',
    icon: 'nextjs',
    category: 'frontend',
    tags: ['nextjs', 'react', 'typescript', 'tailwind', 'ssr'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', version: '0.1.0', private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
        dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
        devDependencies: { '@types/node': '^22.0.0', '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0', autoprefixer: '^10.4.20', postcss: '^8.4.49', tailwindcss: '^3.4.17', typescript: '^5.6.0' },
      }, null, 2),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', incremental: true, plugins: [{ name: 'next' }], paths: { '@/*': ['./src/*'] } },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'],
      }, null, 2),
      'next.config.ts': "import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n",
      'tailwind.config.ts': "import type { Config } from 'tailwindcss';\n\nconst config: Config = {\n  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],\n  theme: { extend: {} },\n  plugins: [],\n};\n\nexport default config;\n",
      'postcss.config.mjs': "const config = {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\nexport default config;\n",
      'src/app/layout.tsx': "import type { Metadata } from 'next';\nimport './globals.css';\n\nexport const metadata: Metadata = {\n  title: '{{PROJECT_NAME}}',\n  description: 'Created with guIDE',\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body className=\"antialiased\">{children}</body>\n    </html>\n  );\n}\n",
      'src/app/page.tsx': "export default function Home() {\n  return (\n    <main className=\"min-h-screen bg-gray-900 text-white flex items-center justify-center\">\n      <div className=\"text-center space-y-6\">\n        <h1 className=\"text-5xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent\">\n          {{PROJECT_NAME}}\n        </h1>\n        <p className=\"text-gray-400 text-lg\">Next.js App Router + TypeScript + Tailwind</p>\n      </div>\n    </main>\n  );\n}\n",
      'src/app/globals.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
      '.gitignore': 'node_modules\n.next\nout\n.env\n.env.local\n',
      'README.md': '# {{PROJECT_NAME}}\n\nNext.js project scaffolded by guIDE.\n\n## Getting Started\n\n```bash\nnpm install\nnpm run dev\n```\n\nOpen [http://localhost:3000](http://localhost:3000).\n',
    },
  },
  {
    id: 'express-api',
    name: 'Express REST API',
    description: 'Node.js REST API with Express, CORS, and environment variables',
    icon: 'nodejs',
    category: 'backend',
    tags: ['node', 'express', 'api', 'rest', 'javascript'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', version: '1.0.0', type: 'module',
        scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js' },
        dependencies: { cors: '^2.8.5', dotenv: '^16.4.0', express: '^4.21.0' },
      }, null, 2),
      'src/index.js': "import express from 'express';\nimport cors from 'cors';\nimport 'dotenv/config';\n\nconst app = express();\nconst PORT = process.env.PORT || 3000;\n\napp.use(cors());\napp.use(express.json());\n\napp.get('/', (req, res) => {\n  res.json({ message: 'Welcome to {{PROJECT_NAME}} API', version: '1.0.0' });\n});\n\napp.get('/api/health', (req, res) => {\n  res.json({ status: 'ok', uptime: process.uptime() });\n});\n\nconst items = [];\n\napp.get('/api/items', (req, res) => res.json(items));\n\napp.post('/api/items', (req, res) => {\n  const { name, description } = req.body;\n  if (!name) return res.status(400).json({ error: 'Name is required' });\n  const item = { id: Date.now().toString(), name, description: description || '', createdAt: new Date().toISOString() };\n  items.push(item);\n  res.status(201).json(item);\n});\n\napp.delete('/api/items/:id', (req, res) => {\n  const idx = items.findIndex(i => i.id === req.params.id);\n  if (idx === -1) return res.status(404).json({ error: 'Item not found' });\n  items.splice(idx, 1);\n  res.json({ success: true });\n});\n\napp.use((err, req, res, next) => {\n  console.error(err.stack);\n  res.status(500).json({ error: 'Internal Server Error' });\n});\n\napp.listen(PORT, () => {\n  console.log(`Server running at http://localhost:${PORT}`);\n});\n",
      '.env': 'PORT=3000\nNODE_ENV=development\n',
      '.gitignore': 'node_modules\n.env\n',
      'README.md': '# {{PROJECT_NAME}}\n\nREST API built with Express.js, scaffolded by guIDE.\n\n## Getting Started\n\n```bash\nnpm install\nnpm run dev\n```\n\nAPI at [http://localhost:3000](http://localhost:3000).\n',
    },
  },
  {
    id: 'python-fastapi',
    name: 'Python FastAPI',
    description: 'Modern Python API with FastAPI, Pydantic, and uvicorn',
    icon: 'python',
    category: 'backend',
    tags: ['python', 'fastapi', 'api', 'async'],
    files: {
      'requirements.txt': 'fastapi>=0.115.0\nuvicorn[standard]>=0.32.0\npydantic>=2.10.0\npython-dotenv>=1.0.0\n',
      'main.py': '"""{{PROJECT_NAME}} -- FastAPI Application"""\nfrom fastapi import FastAPI, HTTPException\nfrom fastapi.middleware.cors import CORSMiddleware\nfrom pydantic import BaseModel\nfrom datetime import datetime\n\napp = FastAPI(title="{{PROJECT_NAME}}", version="1.0.0")\n\napp.add_middleware(\n    CORSMiddleware,\n    allow_origins=["*"],\n    allow_credentials=True,\n    allow_methods=["*"],\n    allow_headers=["*"],\n)\n\n\nclass Item(BaseModel):\n    name: str\n    description: str = ""\n\n\nclass ItemResponse(Item):\n    id: str\n    created_at: str\n\n\nitems_db: list[ItemResponse] = []\n\n\n@app.get("/")\nasync def root():\n    return {"message": f"Welcome to {{PROJECT_NAME}}", "version": "1.0.0"}\n\n\n@app.get("/api/health")\nasync def health():\n    return {"status": "ok"}\n\n\n@app.get("/api/items", response_model=list[ItemResponse])\nasync def list_items():\n    return items_db\n\n\n@app.post("/api/items", response_model=ItemResponse, status_code=201)\nasync def create_item(item: Item):\n    new_item = ItemResponse(\n        id=str(len(items_db) + 1),\n        name=item.name,\n        description=item.description,\n        created_at=datetime.now().isoformat(),\n    )\n    items_db.append(new_item)\n    return new_item\n\n\n@app.delete("/api/items/{item_id}")\nasync def delete_item(item_id: str):\n    for i, item in enumerate(items_db):\n        if item.id == item_id:\n            items_db.pop(i)\n            return {"success": True}\n    raise HTTPException(status_code=404, detail="Item not found")\n\n\nif __name__ == "__main__":\n    import uvicorn\n    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)\n',
      '.gitignore': '__pycache__\n*.pyc\n.env\n.venv\nvenv\n',
      'README.md': '# {{PROJECT_NAME}}\n\nPython API built with FastAPI, scaffolded by guIDE.\n\n## Getting Started\n\n```bash\npip install -r requirements.txt\npython main.py\n```\n\nAPI at [http://localhost:8000](http://localhost:8000) -- Swagger docs at [/docs](http://localhost:8000/docs).\n',
    },
  },
  {
    id: 'electron-app',
    name: 'Electron Desktop App',
    description: 'Cross-platform desktop app with Electron and HTML/CSS/JS',
    icon: 'electron',
    category: 'desktop',
    tags: ['electron', 'desktop', 'javascript'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', version: '1.0.0', main: 'main.js',
        scripts: { start: 'electron .', dev: 'electron . --dev' },
        devDependencies: { electron: '^33.0.0' },
      }, null, 2),
      'main.js': "const { app, BrowserWindow } = require('electron');\nconst path = require('path');\n\nfunction createWindow() {\n  const win = new BrowserWindow({\n    width: 1200, height: 800,\n    webPreferences: { nodeIntegration: false, contextIsolation: true },\n  });\n  win.loadFile('index.html');\n}\n\napp.whenReady().then(createWindow);\napp.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });\napp.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });\n",
      'index.html': '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>{{PROJECT_NAME}}</title>\n  <style>\n    * { margin: 0; padding: 0; box-sizing: border-box; }\n    body { font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif; background: #1e1e1e; color: #d4d4d4; display: flex; align-items: center; justify-content: center; min-height: 100vh; }\n    h1 { font-size: 2.5rem; background: linear-gradient(135deg, #4fc1ff, #9b59b6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }\n    p { color: #858585; margin-bottom: 2rem; }\n    button { padding: 12px 24px; background: #007acc; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }\n    button:hover { background: #005fa3; }\n    #counter { font-size: 3rem; font-weight: bold; margin: 1rem 0; color: #4fc1ff; }\n  </style>\n</head>\n<body>\n  <div class="container" style="text-align:center">\n    <h1>{{PROJECT_NAME}}</h1>\n    <p>Electron Desktop App</p>\n    <div id="counter">0</div>\n    <button onclick="document.getElementById(\'counter\').textContent = ++count">Click Me</button>\n  </div>\n  <script>let count = 0;</script>\n</body>\n</html>\n',
      '.gitignore': 'node_modules\ndist\nout\n',
      'README.md': '# {{PROJECT_NAME}}\n\nElectron desktop app scaffolded by guIDE.\n\n## Getting Started\n\n```bash\nnpm install\nnpm start\n```\n',
    },
  },
  {
    id: 'static-html',
    name: 'Static HTML/CSS/JS',
    description: 'Simple static website with HTML, CSS, and vanilla JavaScript',
    icon: 'html',
    category: 'frontend',
    tags: ['html', 'css', 'javascript', 'static'],
    files: {
      'index.html': '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>{{PROJECT_NAME}}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <header>\n    <nav>\n      <h1>{{PROJECT_NAME}}</h1>\n      <ul>\n        <li><a href="#home">Home</a></li>\n        <li><a href="#about">About</a></li>\n        <li><a href="#contact">Contact</a></li>\n      </ul>\n    </nav>\n  </header>\n  <main>\n    <section id="home" class="hero">\n      <h2>Welcome to {{PROJECT_NAME}}</h2>\n      <p>A clean, modern website built with vanilla HTML, CSS, and JavaScript.</p>\n      <button id="ctaBtn">Get Started</button>\n    </section>\n  </main>\n  <footer><p>Built with guIDE</p></footer>\n  <script src="script.js"></script>\n</body>\n</html>\n',
      'style.css': '* { margin: 0; padding: 0; box-sizing: border-box; }\n:root { --bg: #0f172a; --surface: #1e293b; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; --accent-hover: #2563eb; }\nbody { font-family: \'Inter\', -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }\nheader { background: var(--surface); border-bottom: 1px solid #334155; padding: 1rem 2rem; }\nnav { display: flex; justify-content: space-between; align-items: center; max-width: 1200px; margin: auto; }\nnav h1 { font-size: 1.25rem; color: var(--accent); }\nnav ul { display: flex; list-style: none; gap: 1.5rem; }\nnav a { color: var(--muted); text-decoration: none; transition: color 0.2s; }\nnav a:hover { color: var(--text); }\n.hero { min-height: 80vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2rem; }\n.hero h2 { font-size: 3rem; margin-bottom: 1rem; }\n.hero p { color: var(--muted); font-size: 1.2rem; margin-bottom: 2rem; max-width: 600px; }\nbutton { padding: 12px 32px; background: var(--accent); color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; transition: background 0.2s; }\nbutton:hover { background: var(--accent-hover); }\nfooter { text-align: center; padding: 2rem; color: var(--muted); font-size: 0.875rem; border-top: 1px solid #334155; }\n',
      'script.js': "document.addEventListener('DOMContentLoaded', () => {\n  const ctaBtn = document.getElementById('ctaBtn');\n  if (ctaBtn) {\n    ctaBtn.addEventListener('click', () => {\n      alert('Welcome to {{PROJECT_NAME}}!');\n    });\n  }\n});\n",
      'README.md': '# {{PROJECT_NAME}}\n\nStatic website scaffolded by guIDE.\n\n## Getting Started\n\nOpen `index.html` in your browser, or:\n\n```bash\nnpx serve .\n```\n',
    },
  },
  {
    id: 'chrome-extension',
    name: 'Chrome Extension',
    description: 'Manifest V3 Chrome extension with popup, content script, and background worker',
    icon: 'chrome',
    category: 'tools',
    tags: ['chrome', 'extension', 'browser', 'javascript'],
    files: {
      'manifest.json': JSON.stringify({
        manifest_version: 3, name: '{{PROJECT_NAME}}', version: '1.0.0',
        description: 'A Chrome extension scaffolded by guIDE',
        permissions: ['activeTab', 'storage'],
        action: { default_popup: 'popup.html' },
        background: { service_worker: 'background.js' },
        content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], css: ['content.css'] }],
      }, null, 2),
      'popup.html': '<!DOCTYPE html>\n<html>\n<head>\n  <style>\n    body { width: 320px; padding: 16px; font-family: -apple-system, sans-serif; background: #1e1e1e; color: #d4d4d4; }\n    h2 { font-size: 16px; margin-bottom: 12px; color: #4fc1ff; }\n    button { width: 100%; padding: 10px; background: #007acc; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; margin-top: 8px; }\n    button:hover { background: #005fa3; }\n    #status { margin-top: 12px; font-size: 13px; color: #858585; }\n  </style>\n</head>\n<body>\n  <h2>{{PROJECT_NAME}}</h2>\n  <button id="actionBtn">Run Action</button>\n  <div id="status"></div>\n  <script src="popup.js"></script>\n</body>\n</html>\n',
      'popup.js': "document.getElementById('actionBtn').addEventListener('click', async () => {\n  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });\n  chrome.scripting.executeScript({\n    target: { tabId: tab.id },\n    func: () => { document.title = '{{PROJECT_NAME}} was here!'; },\n  });\n  document.getElementById('status').textContent = 'Action executed on: ' + tab.url;\n});\n",
      'background.js': "chrome.runtime.onInstalled.addListener(() => {\n  console.log('{{PROJECT_NAME}} extension installed');\n});\n",
      'content.js': "console.log('{{PROJECT_NAME}} content script loaded');\n",
      'content.css': '/* Content script styles */\n',
      'README.md': '# {{PROJECT_NAME}}\n\nChrome Extension (Manifest V3) scaffolded by guIDE.\n\n## Installation\n\n1. Open `chrome://extensions`\n2. Enable "Developer mode"\n3. Click "Load unpacked" and select this folder\n',
    },
  },
  {
    id: 'discord-bot',
    name: 'Discord Bot',
    description: 'Discord bot with slash commands using discord.js v14',
    icon: 'bot',
    category: 'tools',
    tags: ['discord', 'bot', 'node', 'javascript'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', version: '1.0.0', type: 'module',
        scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js', deploy: 'node src/deploy-commands.js' },
        dependencies: { 'discord.js': '^14.16.0', dotenv: '^16.4.0' },
      }, null, 2),
      '.env': 'DISCORD_TOKEN=your_bot_token_here\nCLIENT_ID=your_client_id_here\nGUILD_ID=your_guild_id_here\n',
      'src/index.js': "import { Client, GatewayIntentBits, Collection } from 'discord.js';\nimport 'dotenv/config';\n\nconst client = new Client({\n  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],\n});\n\nclient.commands = new Collection();\n\nclient.commands.set('ping', {\n  name: 'ping',\n  execute: async (interaction) => {\n    const latency = Date.now() - interaction.createdTimestamp;\n    await interaction.reply(`Pong! Latency: ${latency}ms`);\n  },\n});\n\nclient.commands.set('hello', {\n  name: 'hello',\n  execute: async (interaction) => {\n    await interaction.reply(`Hello, ${interaction.user.displayName}!`);\n  },\n});\n\nclient.once('ready', (c) => {\n  console.log(`Logged in as ${c.user.tag}`);\n});\n\nclient.on('interactionCreate', async (interaction) => {\n  if (!interaction.isChatInputCommand()) return;\n  const command = client.commands.get(interaction.commandName);\n  if (!command) return;\n  try {\n    await command.execute(interaction);\n  } catch (error) {\n    console.error(`Error executing ${interaction.commandName}:`, error);\n    const reply = { content: 'Something went wrong!', ephemeral: true };\n    interaction.replied ? interaction.followUp(reply) : interaction.reply(reply);\n  }\n});\n\nclient.login(process.env.DISCORD_TOKEN);\n",
      'src/deploy-commands.js': "import { REST, Routes, SlashCommandBuilder } from 'discord.js';\nimport 'dotenv/config';\n\nconst commands = [\n  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),\n  new SlashCommandBuilder().setName('hello').setDescription('Say hello'),\n].map(cmd => cmd.toJSON());\n\nconst rest = new REST().setToken(process.env.DISCORD_TOKEN);\n\n(async () => {\n  console.log('Deploying slash commands...');\n  await rest.put(\n    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),\n    { body: commands },\n  );\n  console.log('Commands deployed!');\n})();\n",
      '.gitignore': 'node_modules\n.env\n',
      'README.md': '# {{PROJECT_NAME}}\n\nDiscord bot built with discord.js v14, scaffolded by guIDE.\n\n## Setup\n\n1. Create a bot at [discord.com/developers](https://discord.com/developers)\n2. Copy token to `.env`\n3. Run:\n\n```bash\nnpm install\nnpm run deploy\nnpm run dev\n```\n',
    },
  },
  {
    id: 'cli-tool',
    name: 'CLI Tool (Node.js)',
    description: 'Command-line tool with argument parsing, colors, and interactive prompts',
    icon: 'terminal',
    category: 'tools',
    tags: ['cli', 'node', 'terminal', 'javascript'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', version: '1.0.0', type: 'module',
        bin: { '{{PROJECT_NAME}}': './src/index.js' },
        scripts: { start: 'node src/index.js', dev: 'node src/index.js --help', link: 'npm link' },
        dependencies: {},
      }, null, 2),
      'src/index.js': "#!/usr/bin/env node\n\nconst args = process.argv.slice(2);\nconst flags = {};\nconst positional = [];\n\nfor (let i = 0; i < args.length; i++) {\n  if (args[i].startsWith('--')) {\n    const key = args[i].slice(2);\n    const val = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;\n    flags[key] = val;\n  } else if (args[i].startsWith('-')) {\n    args[i].slice(1).split('').forEach(c => { flags[c] = true; });\n  } else {\n    positional.push(args[i]);\n  }\n}\n\nconst c = {\n  reset: '\\x1b[0m', bold: '\\x1b[1m',\n  red: '\\x1b[31m', green: '\\x1b[32m', yellow: '\\x1b[33m',\n  blue: '\\x1b[34m', cyan: '\\x1b[36m', gray: '\\x1b[90m',\n};\n\nfunction success(msg) { console.log(`${c.green}+${c.reset} ${msg}`); }\nfunction error(msg) { console.log(`${c.red}x${c.reset} ${msg}`); }\nfunction info(msg) { console.log(`${c.blue}i${c.reset} ${msg}`); }\n\nconst commands = {\n  help() {\n    console.log(`\n${c.bold}${c.cyan}{{PROJECT_NAME}}${c.reset} -- CLI Tool\n\n${c.bold}Usage:${c.reset}\n  {{PROJECT_NAME}} <command> [options]\n\n${c.bold}Commands:${c.reset}\n  help        Show this help message\n  greet       Greet a user\n  version     Show version\n\n${c.bold}Options:${c.reset}\n  --name      Name to greet (default: World)\n  --help      Show help\n`);\n  },\n  greet() {\n    const name = flags.name || positional[0] || 'World';\n    success(`Hello, ${name}!`);\n  },\n  version() {\n    info('{{PROJECT_NAME}} v1.0.0');\n  },\n};\n\nconst command = positional[0] || 'help';\nconst handler = commands[command];\nif (handler) { handler(); } else { error(`Unknown command: ${command}`); commands.help(); process.exit(1); }\n",
      '.gitignore': 'node_modules\n',
      'README.md': '# {{PROJECT_NAME}}\n\nCLI tool scaffolded by guIDE.\n\n## Usage\n\n```bash\nnode src/index.js greet --name "John"\nnode src/index.js help\n```\n\n## Install globally\n\n```bash\nnpm link\n{{PROJECT_NAME}} greet --name "John"\n```\n',
    },
  },
  {
    id: 'vue-vite',
    name: 'Vue 3 + TypeScript',
    description: 'Vue 3 app with TypeScript, Vite, and Vue Router',
    icon: 'vue',
    category: 'frontend',
    tags: ['vue', 'typescript', 'vite'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', private: true, version: '0.1.0', type: 'module',
        scripts: { dev: 'vite', build: 'vue-tsc && vite build', preview: 'vite preview' },
        dependencies: { vue: '^3.5.0', 'vue-router': '^4.4.0' },
        devDependencies: { '@vitejs/plugin-vue': '^5.2.0', 'vue-tsc': '^2.1.0', typescript: '^5.6.0', vite: '^6.0.0' },
      }, null, 2),
      'vite.config.ts': "import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\n\nexport default defineConfig({\n  plugins: [vue()],\n});\n",
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'ESNext', lib: ['ES2020', 'DOM'], skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true, noEmit: true, jsx: 'preserve', strict: true }, include: ['src'] }, null, 2),
      'index.html': '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>{{PROJECT_NAME}}</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n',
      'src/main.ts': "import { createApp } from 'vue';\nimport { createRouter, createWebHistory } from 'vue-router';\nimport App from './App.vue';\nimport Home from './views/Home.vue';\n\nconst router = createRouter({\n  history: createWebHistory(),\n  routes: [{ path: '/', component: Home }],\n});\n\ncreateApp(App).use(router).mount('#app');\n",
      'src/App.vue': '<template>\n  <div id="app">\n    <nav><router-link to="/">Home</router-link></nav>\n    <router-view />\n  </div>\n</template>\n\n<script setup lang="ts"></script>\n\n<style>\n* { box-sizing: border-box; margin: 0; padding: 0; }\nbody { font-family: system-ui, sans-serif; background: #0d0d0d; color: #e0e0e0; }\nnav { padding: 1rem; border-bottom: 1px solid #333; }\nnav a { color: #42b883; text-decoration: none; }\n</style>\n',
      'src/views/Home.vue': '<template>\n  <div style="padding:2rem">\n    <h1 style="color:#42b883">{{ title }}</h1>\n    <p>Edit <code>src/views/Home.vue</code> to get started.</p>\n    <button @click="count++">Clicked {{ count }} times</button>\n  </div>\n</template>\n\n<script setup lang="ts">\nimport { ref } from \'vue\';\nconst title = \'{{PROJECT_NAME}}\';\nconst count = ref(0);\n</script>\n',
      '.gitignore': 'node_modules\ndist\n',
      'README.md': '# {{PROJECT_NAME}}\n\nVue 3 + TypeScript + Vite.\n\n## Setup\n\n```bash\nnpm install\nnpm run dev\n```\n',
    },
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    description: 'Full-stack Svelte app with file-based routing and TypeScript',
    icon: 'svelte',
    category: 'frontend',
    tags: ['svelte', 'sveltekit', 'vite', 'typescript'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', version: '0.0.1', private: true,
        scripts: { dev: 'vite dev', build: 'vite build', preview: 'vite preview' },
        devDependencies: { '@sveltejs/adapter-auto': '^3.0.0', '@sveltejs/kit': '^2.5.0', '@sveltejs/vite-plugin-svelte': '^3.0.0', svelte: '^4.2.0', vite: '^5.0.0' },
      }, null, 2),
      'svelte.config.js': "import adapter from '@sveltejs/adapter-auto';\nimport { vitePreprocess } from '@sveltejs/vite-plugin-svelte';\n\nconst config = {\n  preprocess: vitePreprocess(),\n  kit: { adapter: adapter() },\n};\n\nexport default config;\n",
      'vite.config.ts': "import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [sveltekit()] });\n",
      'src/app.html': '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    %sveltekit.head%\n  </head>\n  <body>\n    <div style="display:contents">%sveltekit.body%</div>\n  </body>\n</html>\n',
      'src/routes/+layout.svelte': '<slot />\n',
      'src/routes/+page.svelte': '<script lang="ts">\n  let count = 0;\n</script>\n\n<svelte:head><title>{{PROJECT_NAME}}</title></svelte:head>\n\n<main>\n  <h1>{{PROJECT_NAME}}</h1>\n  <p>Edit <code>src/routes/+page.svelte</code> to get started.</p>\n  <button on:click={() => count++}>Clicked {count} times</button>\n</main>\n\n<style>\n  main { padding: 2rem; font-family: system-ui, sans-serif; }\n  h1 { color: #ff3e00; font-size: 2rem; margin-bottom: 1rem; }\n  button { padding: 8px 16px; background: #ff3e00; color: white; border: none; border-radius: 4px; cursor: pointer; }\n</style>\n',
      '.gitignore': 'node_modules\n.svelte-kit\nbuild\n',
      'README.md': '# {{PROJECT_NAME}}\n\nSvelteKit project.\n\n## Setup\n\n```bash\nnpm install\nnpm run dev\n```\n',
    },
  },
  {
    id: 'python-flask',
    name: 'Flask REST API',
    description: 'Lightweight Python REST API with Flask, CORS, and env config',
    icon: 'flask',
    category: 'backend',
    tags: ['python', 'flask', 'rest', 'api'],
    files: {
      'app.py': '"""{{PROJECT_NAME}} -- Flask REST API"""\nfrom flask import Flask, jsonify, request\nfrom flask_cors import CORS\nfrom dotenv import load_dotenv\nimport os\n\nload_dotenv()\napp = Flask(__name__)\nCORS(app)\n\nitems = [\n    {"id": 1, "name": "Item One"},\n    {"id": 2, "name": "Item Two"},\n]\nnext_id = 3\n\n\n@app.route("/")\ndef index():\n    return jsonify({"status": "ok", "app": "{{PROJECT_NAME}}"})\n\n\n@app.route("/api/items", methods=["GET"])\ndef get_items():\n    return jsonify(items)\n\n\n@app.route("/api/items", methods=["POST"])\ndef create_item():\n    global next_id\n    data = request.get_json()\n    if not data or not data.get("name"):\n        return jsonify({"error": "name required"}), 400\n    item = {"id": next_id, "name": data["name"]}\n    items.append(item)\n    next_id += 1\n    return jsonify(item), 201\n\n\n@app.route("/api/items/<int:item_id>", methods=["DELETE"])\ndef delete_item(item_id):\n    global items\n    before = len(items)\n    items = [i for i in items if i["id"] != item_id]\n    if len(items) == before:\n        return jsonify({"error": "Not found"}), 404\n    return jsonify({"deleted": item_id})\n\n\nif __name__ == "__main__":\n    port = int(os.getenv("PORT", 5000))\n    app.run(host="0.0.0.0", port=port, debug=True)\n',
      'requirements.txt': 'flask>=3.0.0\nflask-cors>=4.0.0\npython-dotenv>=1.0.0\n',
      '.env': 'PORT=5000\nFLASK_DEBUG=1\n',
      '.gitignore': '__pycache__\n*.pyc\n.env\n.venv/\nvenv/\n',
      'README.md': '# {{PROJECT_NAME}}\n\nFlask REST API.\n\n## Setup\n\n```bash\npython -m venv .venv\n.venv\\Scripts\\activate\npip install -r requirements.txt\npython app.py\n```\n\nAPI at `http://localhost:5000`\n',
    },
  },
  {
    id: 'docker-compose',
    name: 'Docker Compose App',
    description: 'Node API + Nginx reverse proxy + Postgres, wired with Docker Compose',
    icon: 'docker',
    category: 'backend',
    tags: ['docker', 'compose', 'nginx', 'postgres', 'node'],
    files: {
      'docker-compose.yml': "version: '3.9'\nservices:\n  api:\n    build: ./api\n    environment:\n      - NODE_ENV=development\n      - DATABASE_URL=postgres://user:pass@db:5432/{{PROJECT_NAME}}\n    depends_on: [db]\n    restart: unless-stopped\n\n  nginx:\n    image: nginx:alpine\n    ports: [\"80:80\"]\n    volumes:\n      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro\n    depends_on: [api]\n    restart: unless-stopped\n\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: user\n      POSTGRES_PASSWORD: pass\n      POSTGRES_DB: {{PROJECT_NAME}}\n    volumes: [pgdata:/var/lib/postgresql/data]\n    restart: unless-stopped\n\nvolumes:\n  pgdata:\n",
      'api/Dockerfile': "FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE 3000\nCMD [\"node\", \"index.js\"]\n",
      'api/package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}-api', version: '1.0.0',
        scripts: { start: 'node index.js', dev: 'node --watch index.js' },
        dependencies: { express: '^4.21.0' },
      }, null, 2),
      'api/index.js': "const express = require('express');\nconst app = express();\napp.use(express.json());\n\napp.get('/health', (_, res) => res.json({ status: 'ok' }));\napp.get('/api', (_, res) => res.json({ message: 'Hello from {{PROJECT_NAME}}' }));\n\nconst PORT = process.env.PORT || 3000;\napp.listen(PORT, () => console.log('API running on port ' + PORT));\n",
      'nginx/nginx.conf': "events { worker_connections 1024; }\nhttp {\n  server {\n    listen 80;\n    location /api { proxy_pass http://api:3000; }\n    location /health { proxy_pass http://api:3000; }\n  }\n}\n",
      '.gitignore': 'node_modules\n.env\n',
      'README.md': '# {{PROJECT_NAME}}\n\nDocker Compose: Node API + Nginx + Postgres.\n\n## Start\n\n```bash\ndocker compose up --build\n```\n\n- API: `http://localhost/api`\n- Health: `http://localhost/health`\n',
    },
  },
  {
    id: 'python-ai-agent',
    name: 'Python AI Agent',
    description: 'Local AI agent using Ollama -- offline, no API keys, runs on your GPU',
    icon: 'ai',
    category: 'ai',
    tags: ['python', 'ai', 'ollama', 'local', 'agent'],
    files: {
      'agent.py': '"""{{PROJECT_NAME}} -- Local AI Agent via Ollama"""\nimport json\nimport os\nimport requests\nfrom tools import TOOLS, call_tool\n\nOLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")\nMODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:7b")\n\n\ndef chat(messages):\n    resp = requests.post(\n        OLLAMA_URL + "/api/chat",\n        json={"model": MODEL, "messages": messages, "tools": TOOLS, "stream": False},\n        timeout=120,\n    )\n    resp.raise_for_status()\n    return resp.json()["message"]\n\n\ndef run_agent(user_message, max_steps=10):\n    messages = [\n        {"role": "system", "content": "You are a helpful assistant with tools."},\n        {"role": "user", "content": user_message},\n    ]\n    for _ in range(max_steps):\n        response = chat(messages)\n        messages.append(response)\n        if not response.get("tool_calls"):\n            return response.get("content", "")\n        for tc in response["tool_calls"]:\n            name = tc["function"]["name"]\n            args = tc["function"]["arguments"]\n            if isinstance(args, str):\n                args = json.loads(args)\n            print("  [tool] " + name + str(args))\n            result = call_tool(name, args)\n            messages.append({"role": "tool", "content": json.dumps(result)})\n    return "Max steps reached."\n\n\nif __name__ == "__main__":\n    print("Agent ready. Model: " + MODEL)\n    print("Type quit to exit.")\n    while True:\n        try:\n            user_input = input("You: ").strip()\n        except (EOFError, KeyboardInterrupt):\n            break\n        if not user_input or user_input.lower() in ("quit", "exit"):\n            break\n        print("Agent: " + run_agent(user_input))\n',
      'tools.py': '"""Tool definitions"""\nimport datetime\nimport math\n\nTOOLS = [\n    {\n        "type": "function",\n        "function": {\n            "name": "get_current_time",\n            "description": "Return the current date and time",\n            "parameters": {"type": "object", "properties": {}, "required": []},\n        },\n    },\n    {\n        "type": "function",\n        "function": {\n            "name": "calculate",\n            "description": "Evaluate a math expression",\n            "parameters": {\n                "type": "object",\n                "properties": {"expression": {"type": "string"}},\n                "required": ["expression"],\n            },\n        },\n    },\n]\n\n\ndef get_current_time():\n    now = datetime.datetime.now()\n    return {"datetime": now.isoformat()}\n\n\ndef calculate(expression):\n    safe = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")}\n    try:\n        return {"result": eval(expression, {"__builtins__": {}}, safe)}\n    except Exception as e:\n        return {"error": str(e)}\n\n\ndef call_tool(name, args):\n    if name == "get_current_time":\n        return get_current_time()\n    if name == "calculate":\n        return calculate(**args)\n    return {"error": "Unknown tool: " + name}\n',
      'requirements.txt': 'requests>=2.31.0\n',
      '.env': 'OLLAMA_MODEL=qwen2.5-coder:7b\nOLLAMA_URL=http://localhost:11434\n',
      '.gitignore': '__pycache__\n*.pyc\n.env\n.venv/\n',
      'README.md': '# {{PROJECT_NAME}}\n\nLocal AI agent using Ollama. No API keys needed.\n\n## Prerequisites\n\n1. Install [Ollama](https://ollama.com)\n2. `ollama pull qwen2.5-coder:7b`\n\n## Setup\n\n```bash\npip install -r requirements.txt\npython agent.py\n```\n\nAdd tools in `tools.py`.\n',
    },
  },
  {
    id: 'node-mcp-server',
    name: 'MCP Server (Node)',
    description: 'Custom Model Context Protocol server -- expose tools to any LLM',
    icon: 'mcp',
    category: 'ai',
    tags: ['mcp', 'node', 'ai', 'tools'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', version: '1.0.0', type: 'module',
        scripts: { start: 'node src/index.js', dev: 'node --watch src/index.js' },
        dependencies: { '@modelcontextprotocol/sdk': '^1.5.0', zod: '^3.24.0' },
      }, null, 2),
      'src/index.js': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\nimport { tools } from './tools.js';\n\nconst server = new McpServer({ name: '{{PROJECT_NAME}}', version: '1.0.0' });\n\nfor (const tool of tools) {\n  server.tool(tool.name, tool.description, tool.schema, tool.handler);\n}\n\nconst transport = new StdioServerTransport();\nawait server.connect(transport);\nconsole.error('{{PROJECT_NAME}} MCP server ready');\n",
      'src/tools.js': "import { z } from 'zod';\n\nexport const tools = [\n  {\n    name: 'echo',\n    description: 'Echo a message back',\n    schema: { message: z.string().describe('Message to echo') },\n    async handler({ message }) {\n      return { content: [{ type: 'text', text: 'Echo: ' + message }] };\n    },\n  },\n  {\n    name: 'timestamp',\n    description: 'Return the current UTC timestamp',\n    schema: {},\n    async handler() {\n      return { content: [{ type: 'text', text: new Date().toISOString() }] };\n    },\n  },\n  {\n    name: 'random_number',\n    description: 'Generate a random integer between min and max',\n    schema: {\n      min: z.number().default(0),\n      max: z.number().default(100),\n    },\n    async handler({ min = 0, max = 100 }) {\n      const n = Math.floor(Math.random() * (max - min + 1)) + min;\n      return { content: [{ type: 'text', text: String(n) }] };\n    },\n  },\n];\n",
      '.gitignore': 'node_modules\n',
      'README.md': '# {{PROJECT_NAME}}\n\nMCP Server -- expose tools to any compatible LLM client.\n\n## Setup\n\n```bash\nnpm install\nnpm start\n```\n\nAdd tools in `src/tools.js`.\n',
    },
  },
  {
    id: 'tauri-app',
    name: 'Tauri Desktop App',
    description: 'Lightweight desktop app with Tauri, React, and TypeScript',
    icon: 'tauri',
    category: 'desktop',
    tags: ['tauri', 'react', 'typescript', 'desktop', 'rust'],
    files: {
      'package.json': JSON.stringify({
        name: '{{PROJECT_NAME}}', private: true, version: '0.1.0', type: 'module',
        scripts: { dev: 'vite', build: 'tsc && vite build', 'tauri:dev': 'tauri dev', 'tauri:build': 'tauri build' },
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', '@tauri-apps/api': '^2.0.0' },
        devDependencies: { '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0', '@vitejs/plugin-react': '^4.3.0', typescript: '^5.6.0', vite: '^6.0.0', '@tauri-apps/cli': '^2.0.0' },
      }, null, 2),
      'index.html': '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>{{PROJECT_NAME}}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
      'src/main.tsx': "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n",
      'src/App.tsx': "import { useState } from 'react';\n\nfunction App() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <div style={{ minHeight: '100vh', background: '#1e1e1e', color: '#d4d4d4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>\n      <div style={{ textAlign: 'center' }}>\n        <h1 style={{ fontSize: '2.5rem', color: '#4fc1ff' }}>{{PROJECT_NAME}}</h1>\n        <p style={{ color: '#858585', marginBottom: '2rem' }}>Tauri + React + TypeScript</p>\n        <button onClick={() => setCount(c => c + 1)} style={{ padding: '12px 24px', background: '#007acc', color: 'white', border: 'none', borderRadius: '8px', fontSize: '1rem', cursor: 'pointer' }}>\n          Count: {count}\n        </button>\n      </div>\n    </div>\n  );\n}\n\nexport default App;\n",
      'vite.config.ts': "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  clearScreen: false,\n  server: { strictPort: true },\n});\n",
      '.gitignore': 'node_modules\ndist\nsrc-tauri/target\n',
      'README.md': '# {{PROJECT_NAME}}\n\nTauri desktop app scaffolded by guIDE.\n\n## Prerequisites\n\n- [Rust](https://www.rust-lang.org/tools/install)\n- Node.js 18+\n\n## Getting Started\n\n```bash\nnpm install\nnpm run tauri:dev\n```\n',
    },
  },
  {
    id: 'rust-cli',
    name: 'Rust CLI',
    description: 'Fast command-line tool written in Rust with clap argument parsing',
    icon: 'rust',
    category: 'tools',
    tags: ['rust', 'cli', 'terminal'],
    files: {
      'Cargo.toml': '[package]\nname = "{{PROJECT_NAME}}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nclap = { version = "4", features = ["derive"] }\n',
      'src/main.rs': 'use clap::Parser;\n\n#[derive(Parser, Debug)]\n#[command(name = "{{PROJECT_NAME}}", about = "A CLI tool built with Rust")]\nstruct Args {\n    /// Name to greet\n    #[arg(short, long, default_value = "World")]\n    name: String,\n\n    /// Number of times to greet\n    #[arg(short, long, default_value_t = 1)]\n    count: u8,\n}\n\nfn main() {\n    let args = Args::parse();\n    for _ in 0..args.count {\n        println!("Hello, {}!", args.name);\n    }\n}\n',
      '.gitignore': '/target\n',
      'README.md': '# {{PROJECT_NAME}}\n\nRust CLI tool scaffolded by guIDE.\n\n## Build & Run\n\n```bash\ncargo run -- --name "World" --count 3\n```\n',
    },
  },
];

// ─── Route Registration ──────────────────────────────────────────────
function register(app, options = {}) {
  const { openProjectPath } = options;

  // List all templates (metadata only, no file contents)
  app.get('/api/templates', (req, res) => {
    const list = TEMPLATES.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: t.icon,
      category: t.category,
      tags: t.tags,
    }));
    res.json(list);
  });

  // Get template details (includes file list but not contents)
  app.get('/api/templates/:id', (req, res) => {
    const template = TEMPLATES.find(t => t.id === req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({
      ...template,
      files: undefined,
      fileList: Object.keys(template.files),
    });
  });

  // Create project from template
  app.post('/api/templates/create', async (req, res) => {
    const { templateId, projectName, parentDir } = req.body;
    if (!templateId || !projectName || !parentDir) {
      return res.status(400).json({ error: 'templateId, projectName, and parentDir are required' });
    }

    const template = TEMPLATES.find(t => t.id === templateId);
    if (!template) return res.status(404).json({ error: `Template "${templateId}" not found` });

    // Sanitize project name for filesystem
    const safeName = projectName.replace(/[<>:"/\\|?*]/g, '-').replace(/\s+/g, '-').toLowerCase();
    const projectDir = path.join(parentDir, safeName);

    try {
      // Check if directory already exists
      try {
        await fs.access(projectDir);
        return res.status(409).json({ error: `Directory "${safeName}" already exists in ${parentDir}` });
      } catch { /* good -- doesn't exist */ }

      // Create project directory
      await fs.mkdir(projectDir, { recursive: true });

      // Write all template files
      const createdFiles = [];
      for (const [relativePath, content] of Object.entries(template.files)) {
        const filePath = path.join(projectDir, relativePath);
        const fileDir = path.dirname(filePath);
        await fs.mkdir(fileDir, { recursive: true });

        // Replace template placeholders
        const processedContent = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
        await fs.writeFile(filePath, processedContent, 'utf8');
        createdFiles.push(relativePath);
      }

      const openedProject = typeof openProjectPath === 'function'
        ? await openProjectPath(projectDir)
        : { path: projectDir };

      res.json({
        success: true,
        projectDir,
        path: openedProject?.path || projectDir,
        projectName: safeName,
        filesCreated: createdFiles,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { register, TEMPLATES };

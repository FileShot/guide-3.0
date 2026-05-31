'use strict';

/**
 * devContainerManager — parse devcontainer.json and start via docker compose (MVP).
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

class DevContainerManager {
  constructor() {
    this._processes = new Map();
  }

  findConfig(projectPath) {
    if (!projectPath) return null;
    const candidates = [
      path.join(projectPath, '.devcontainer', 'devcontainer.json'),
      path.join(projectPath, '.devcontainer.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  parse(projectPath) {
    const configPath = this.findConfig(projectPath);
    if (!configPath) return { success: false, error: 'No devcontainer.json found' };
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
      return {
        success: true,
        configPath,
        config,
        name: config.name || path.basename(projectPath),
        image: config.image,
        dockerComposeFile: config.dockerComposeFile,
        service: config.service || 'app',
        forwardPorts: config.forwardPorts || [],
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  start(projectPath) {
    const parsed = this.parse(projectPath);
    if (!parsed.success) return parsed;

    const { config, configPath } = parsed;
    const devDir = path.dirname(configPath);
    const sessionId = `devcontainer-${Date.now()}`;

    try {
      if (config.dockerComposeFile) {
        const composeFile = Array.isArray(config.dockerComposeFile)
          ? config.dockerComposeFile[0]
          : config.dockerComposeFile;
        const composePath = path.resolve(devDir, composeFile);
        const cwd = path.dirname(composePath);
        const proc = spawn('docker', ['compose', '-f', composePath, 'up', '-d'], {
          cwd,
          stdio: 'pipe',
          shell: process.platform === 'win32',
        });
        this._processes.set(sessionId, proc);
        return {
          success: true,
          sessionId,
          method: 'docker-compose',
          composePath,
          service: config.service,
        };
      }

      if (config.image) {
        execSync(`docker pull ${config.image}`, { stdio: 'pipe', timeout: 300000 });
        const runCmd = `docker run -d -v "${projectPath}:/workspace" -w /workspace ${config.image} sleep infinity`;
        const containerId = execSync(runCmd, { encoding: 'utf8' }).trim();
        return {
          success: true,
          sessionId,
          method: 'docker-run',
          containerId,
          image: config.image,
        };
      }

      return { success: false, error: 'devcontainer.json has no image or dockerComposeFile' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  stop(sessionId) {
    const proc = this._processes.get(sessionId);
    if (proc) {
      try { proc.kill(); } catch (_) {}
      this._processes.delete(sessionId);
    }
    return { success: true };
  }

  status() {
    return {
      active: this._processes.size,
      sessions: [...this._processes.keys()],
    };
  }
}

module.exports = { DevContainerManager };

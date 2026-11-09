// Lettura di ~/.ssh/config di OpenSSH per importare i server in Screenie.
const fs = require('fs');
const os = require('os');
const path = require('path');

function configPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * Restituisce gli host con un nome concreto (niente "*" o "?"), con i campi utili:
 * [{ alias, host, port, username, keyPath, jumpAlias }]
 */
function parseSshConfig(text) {
  const hosts = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = null;
      for (const alias of value.split(/\s+/)) {
        if (/[*?!]/.test(alias)) continue;
        current = { alias, host: alias, port: 22, username: '', keyPath: '', jumpAlias: '' };
        hosts.push(current);
        break; // un alias per blocco basta
      }
    } else if (key === 'match') {
      current = null;
    } else if (current) {
      if (key === 'hostname') current.host = value;
      else if (key === 'port') current.port = Number(value) || 22;
      else if (key === 'user') current.username = value;
      else if (key === 'identityfile' && !current.keyPath) current.keyPath = value;
      else if (key === 'proxyjump') current.jumpAlias = value.split(',')[0].replace(/^.*@/, '').replace(/:\d+$/, '');
    }
  }
  return hosts;
}

function readSshConfig() {
  let text;
  try {
    text = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return { path: configPath(), hosts: [] };
  }
  return { path: configPath(), hosts: parseSshConfig(text) };
}

module.exports = { parseSshConfig, readSshConfig };

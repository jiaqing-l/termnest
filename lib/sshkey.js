'use strict';
const crypto = require('crypto');
const os = require('os');
const { utils } = require('ssh2');

// SSH keys made by TERMNEST: one ed25519 key per server, kept in the encrypted store; the server only ever sees the public half.
function makeKey(label) {
  const comment = `termnest-${String(label || os.hostname()).replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}`;
  const k = utils.generateKeyPairSync('ed25519', { comment });
  return { private: k.private, public: k.public.trim() };
}

// Appends the public key to ~/.ssh/authorized_keys once, with the permissions sshd requires. The key arrives on stdin, so
// nothing of it is part of the command line.
const INSTALL_SCRIPT = [
  'k=$(cat) || exit 2',
  'case "$k" in ssh-ed25519\\ *|ssh-rsa\\ *|ecdsa-sha2-*) ;; *) exit 2;; esac',
  'umask 077; mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || exit 3',
  'f="$HOME/.ssh/authorized_keys"; touch "$f" && chmod 600 "$f" || exit 3',
  'grep -qxF -- "$k" "$f" || printf \'%s\\n\' "$k" >> "$f" || exit 3',
  'echo INSTALLED',
].join('\n');

// What to paste on the server by hand when TERMNEST cannot log in with a password even once.
function manualCommand(publicKey) {
  const q = "'" + publicKey.replace(/'/g, "'\\''") + "'";
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo ${q} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

// Keys made for the "install it myself" path wait here (memory only) until the server is added, at most 30 minutes.
const pending = new Map();
function hold(key) {
  const now = Date.now();
  for (const [ref, v] of pending) if (now - v.at > 30 * 60000) pending.delete(ref);
  const ref = crypto.randomBytes(16).toString('hex');
  pending.set(ref, { ...key, at: now });
  return ref;
}
function take(ref) { const v = typeof ref === 'string' ? pending.get(ref) : null; if (v) pending.delete(ref); return v || null; }

module.exports = { makeKey, INSTALL_SCRIPT, manualCommand, hold, take };

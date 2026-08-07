import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { config } from './config.js';
import { db } from './database.js';
import { aiService } from './aiService.js';
import cron from 'node-cron';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== EXPRESS SERVER ====================
const app = express();
const PORT = process.env.PORT || 3000;
let botStartTime = Date.now();
let currentQR = null;
let pairingMessage = '';

// ==================== GLOBAL STATE ====================
const authenticatedAdmins = new Map();
const broadcastQueue = [];
let targetGroupId = null;
let sock = null;

// ==================== YOUR ADMIN NUMBER ====================
const YOUR_NUMBER = config.admin.rootNumber;
const YOUR_NAME = 'Root Admin';

// ==================== LOGGER ====================
const logger = pino({ level: 'silent' });

const consoleLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
    const emoji = { info: '📘', success: '✅', error: '❌', warning: '⚠️', ai: '🤖', cron: '🕐', game: '🎮', register: '📝' };
    console.log(`${emoji[type] || '📘'} [${timestamp}] ${message}`);
};

// ==================== WEB PAGES ====================
app.get('/', (req, res) => {
    res.redirect('/qr');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/status', (req, res) => {
    const info = aiService.getProviderInfo();
    res.json({
        status: 'online',
        bot: config.botName,
        version: config.version,
        provider: info.current,
        qr: currentQR ? 'ready' : 'waiting',
        pairing: pairingMessage || 'not set',
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', async (req, res) => {
    const PAIRING_CODE = process.env.PAIRING_CODE || '';

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>🤖 7AI Bot - Connect</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                    color: white; 
                    font-family: 'Segoe UI', Arial, sans-serif; 
                    text-align: center; 
                    padding: 20px;
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .container {
                    background: rgba(255,255,255,0.05);
                    backdrop-filter: blur(20px);
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 24px;
                    padding: 40px;
                    max-width: 500px;
                    width: 100%;
                }
                h2 { 
                    font-size: 28px;
                    margin-bottom: 5px;
                    background: linear-gradient(135deg, #00c6ff, #0072ff);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }
                .subtitle {
                    color: #a0a0a0;
                    margin-bottom: 30px;
                    font-size: 14px;
                }
                .step {
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 12px;
                    padding: 20px;
                    margin: 15px 0;
                    text-align: left;
                }
                .step-number {
                    display: inline-block;
                    background: #0072ff;
                    color: white;
                    width: 30px;
                    height: 30px;
                    border-radius: 50%;
                    text-align: center;
                    line-height: 30px;
                    font-weight: bold;
                    margin-right: 10px;
                }
                .step-title {
                    font-size: 16px;
                    font-weight: bold;
                    margin-bottom: 8px;
                    color: #00c6ff;
                }
                .step-desc {
                    font-size: 14px;
                    color: #c0c0c0;
                    line-height: 1.6;
                }
                .pairing-box {
                    background: rgba(0,198,255,0.1);
                    border: 2px dashed #00c6ff;
                    border-radius: 12px;
                    padding: 20px;
                    margin: 20px 0;
                    text-align: center;
                }
                .pairing-box input {
                    background: rgba(0,0,0,0.3);
                    border: 1px solid #00c6ff;
                    color: white;
                    padding: 12px 20px;
                    border-radius: 8px;
                    font-size: 20px;
                    text-align: center;
                    letter-spacing: 5px;
                    width: 200px;
                    margin: 10px 0;
                }
                .pairing-box button {
                    background: #00c6ff;
                    color: #1a1a2e;
                    border: none;
                    padding: 12px 30px;
                    border-radius: 8px;
                    font-size: 16px;
                    font-weight: bold;
                    cursor: pointer;
                    margin-left: 10px;
                }
                .status-badge {
                    display: inline-block;
                    padding: 8px 16px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: bold;
                    margin: 10px 0;
                }
                .status-waiting { background: rgba(255,193,7,0.2); color: #ffc107; }
                .status-ready { background: rgba(76,175,80,0.2); color: #4caf50; }
                .status-error { background: rgba(244,67,54,0.2); color: #f44336; }
                .info-box {
                    background: rgba(255,255,255,0.03);
                    border-radius: 8px;
                    padding: 15px;
                    margin: 15px 0;
                    font-size: 13px;
                    color: #888;
                }
                .note {
                    color: #ff9800;
                    font-size: 13px;
                    margin-top: 10px;
                }
            </style>
            <script>
                setTimeout(() => location.reload(), 30000);
            </script>
        </head>
        <body>
            <div class="container">
                <h2>🤖 7A Intelligence (7AI)</h2>
                <p class="subtitle">Hubungkan Bot WhatsApp</p>
                
                <span class="status-badge status-waiting">⏳ Menunggu Koneksi</span>
                
                <div class="step">
                    <span class="step-number">1</span>
                    <span class="step-title">Buka WhatsApp</span>
                    <p class="step-desc">Buka WhatsApp di HP Anda, lalu masuk ke menu <strong>Perangkat Tertaut</strong></p>
                </div>
                
                <div class="step">
                    <span class="step-number">2</span>
                    <span class="step-title">Pilih Metode Kode</span>
                    <p class="step-desc">Tap <strong>Tautkan Perangkat</strong> lalu pilih <strong>"Tautkan dengan Kode"</strong> (bukan scan QR)</p>
                </div>
                
                <div class="step">
                    <span class="step-number">3</span>
                    <span class="step-title">Dapatkan Kode 8 Digit</span>
                    <p class="step-desc">WhatsApp akan menampilkan <strong>8 digit kode</strong> di layar HP Anda</p>
                </div>
                
                <div class="pairing-box">
                    <p style="margin-bottom:10px;color:#00c6ff;"><strong>🔢 Masukkan Kode:</strong></p>
                    <form action="/set-pairing" method="GET">
                        <input type="text" name="code" placeholder="12345678" maxlength="8" pattern="[0-9]{8}" required>
                        <br>
                        <button type="submit">✅ Hubungkan</button>
                    </form>
                </div>
                
                <div class="info-box">
                    <p>📋 <strong>Info Bot:</strong></p>
                    <p>Nama: ${config.botName} v${config.version}</p>
                    <p>Provider AI: Groq + Google AI Studio</p>
                    <p>Admin: ${formatNumber(YOUR_NUMBER)}</p>
                </div>
                
                <p class="note">💡 Kode hanya valid 60 detik. Jika gagal, refresh halaman & dapatkan kode baru dari WhatsApp.</p>
            </div>
        </body>
        </html>
    `);
});

app.get('/set-pairing', async (req, res) => {
    const code = req.query.code;
    
    if (!code || code.length !== 8 || isNaN(code)) {
        return res.send(`
            <html>
            <head><title>Error</title></head>
            <body style="background:#1a1a2e;color:white;text-align:center;padding:50px;">
                <h2>❌ Kode Tidak Valid!</h2>
                <p>Kode harus 8 digit angka.</p>
                <a href="/qr" style="color:#00c6ff;">Kembali</a>
            </body>
            </html>
        `);
    }

    try {
        if (sock) {
            await sock.requestPairingCode(code);
            pairingMessage = 'Pairing code sent! Waiting for connection...';
            
            res.send(`
                <html>
                <head>
                    <title>✅ Kode Diterima!</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { 
                            background: linear-gradient(135deg, #1a1a2e, #0f3460);
                            color: white; 
                            font-family: Arial; 
                            text-align: center; 
                            padding: 50px 20px;
                        }
                        .success { color: #4caf50; font-size: 50px; }
                        h2 { color: #4caf50; }
                        .btn { 
                            background: #4caf50; color: white; 
                            padding: 12px 24px; border-radius: 8px; 
                            text-decoration: none; display: inline-block; margin-top: 20px; 
                        }
                    </style>
                    <script>
                        setTimeout(() => location.href = '/status', 5000);
                    </script>
                </head>
                <body>
                    <div class="success">✅</div>
                    <h2>Kode Diterima!</h2>
                    <p>Bot sedang menghubungkan ke WhatsApp...</p>
                    <p>Kode: <strong>${code}</strong></p>
                    <p style="color:#ffc107;">Jangan tutup halaman ini.</p>
                    <a href="/status" class="btn">Cek Status</a>
                </body>
                </html>
            `);
        } else {
            res.send('<h2>Bot belum siap</h2><p>Coba lagi nanti.</p>');
        }
    } catch (error) {
        res.send(`
            <html>
            <head><title>Error</title></head>
            <body style="background:#1a1a2e;color:white;text-align:center;padding:50px;">
                <h2>❌ Gagal!</h2>
                <p>${error.message}</p>
                <a href="/qr" style="color:#00c6ff;">Coba Lagi</a>
            </body>
            </html>
        `);
    }
});

// ==================== DATABASE ====================
async function initializeDatabase() {
    try {
        const dbDir = path.join(__dirname, 'database');
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        await db.init();
        const appConfig = await db.getConfig();
        targetGroupId = appConfig.targetGroupId;
        consoleLog('Database initialized', 'success');
    } catch (error) {
        consoleLog('DB Error: ' + error.message, 'error');
    }
}

// ==================== HELPERS ====================
function isAdmin(userId) {
    if (userId === YOUR_NUMBER) return true;
    if (userId === config.admin.rootNumber) return true;
    if (!authenticatedAdmins.has(userId)) return false;
    const session = authenticatedAdmins.get(userId);
    if (Date.now() > session.sessionExpiry) {
        authenticatedAdmins.delete(userId);
        return false;
    }
    return true;
}

async function getUserData(userId) {
    let user = await db.getUser(userId);
    if (!user) {
        const defaultRole = userId === YOUR_NUMBER ? 'root_admin' : 'member';
        const defaultName = userId === YOUR_NUMBER ? YOUR_NAME : 'Siswa 7A';
        const defaultPoints = userId === YOUR_NUMBER ? 999999 : 0;
        user = await db.createUser(userId, { name: defaultName, role: defaultRole, points: defaultPoints });
        consoleLog(`User baru: ${formatNumber(userId)}`, 'register');
    }
    return user;
}

function formatNumber(jid) { return jid.split('@')[0]; }
function parseMention(text) { const match = text.match(/@(\d+)/); return match ? `${match[1]}@s.whatsapp.net` : null; }

async function resolveUser(input) {
    if (!input) return null;
    if (input.startsWith('@')) return parseMention(input);
    if (input.includes('@s.whatsapp.net')) return input;
    const user = await db.getUserByUsername(input);
    if (user) return user.id;
    return input.includes('@') ? input : input + '@s.whatsapp.net';
}

function getCurrentTime() {
    return new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
}

function getCurrentDate() {
    return new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// ==================== COMMANDS ====================
const commands = {
    menu: async (userId) => {
        const user = await getUserData(userId);
        const adminMenu = isAdmin(userId) ? `\n👑 *ADMIN*\n📢 !broadcast <pesan>\n⚙️ !setgroup\n👥 !setrole <user/username> <role>\n💎 !addvip <user/username> <hari>\n🚫 !banned <user/username>\n✅ !unban <user/username>\n💰 !addpoint <user/username> <jumlah>\n🔄 !resetlimit\n🤖 !aistatus\n✅ !acc <id>\n❌ !reject <id>` : '';
        return `🤖 *${config.botName}* v${config.version}\n📅 ${getCurrentDate()} | 🕐 ${getCurrentTime()} WIB\n\n👤 *${user.name}*\n⭐ Role: ${user.role.toUpperCase()}\n💰 Poin: ${user.points}\n━━━━━━━━━━━━━━━━━━\n\n📋 *MENU*\n🤖 !ai <tanya>\n👤 !profile (Japri)\n💰 !poin (Japri)\n🎮 !kuis (+${config.gamePoints} poin)\n📊 !leaderboard\n💎 !claimvip (Japri)\n⚡ !buyvip (Japri)\n🔐 !login <user> <pass> (Japri)\n👤 !setusername <name>${adminMenu}\n\n🕐 Reset: 00:00 WIB`;
    },

    profile: async (userId, chatType) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Chat Pribadi (Japri)!';
        const user = await getUserData(userId);
        let limit = (user.role === 'root_admin' || user.role === 'admin' || user.role === 'operational_admin') ? '∞' : (config.aiLimits[user.role] || 5);
        if (user.vipType === 'fasttrack') limit = config.vip.fastTrack.dailyLimit;
        else if (user.vipType === 'real_vip') limit = Math.max(Math.floor(config.vip.realVip.limitPercentage * user.points), config.aiLimits.real_vip);
        let text = `👤 *PROFIL 7AI*\n\n📱 Nomor: ${formatNumber(userId)}\n`;
        if (user.username) text += `👤 Username: @${user.username}\n`;
        text += `📝 Nama: ${user.name}\n⭐ Role: ${user.role.toUpperCase()}\n💎 VIP: ${user.vipType === 'none' ? '❌ Tidak Aktif' : '✅ ' + user.vipType}\n`;
        if (user.vipType === 'fasttrack' && user.vipExpiredAt) text += `📅 Expired: ${new Date(user.vipExpiredAt).toLocaleDateString('id-ID')}\n`;
        text += `💰 Poin: ${user.points}\n🤖 AI: ${user.aiUsedToday}/${limit}\n📅 Terdaftar: ${new Date(user.registeredAt).toLocaleDateString('id-ID')}\n🚫 Status: ${user.isBanned ? '🔴 Dibanned' : '🟢 Aktif'}`;
        return text;
    },

    poin: async (userId, chatType) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Chat Pribadi (Japri)!';
        const user = await getUserData(userId);
        return `💰 *SALDO POIN*\n\n👤 ${user.name}\n💎 Poin: ${user.points}\n⭐ Role: ${user.role.toUpperCase()}\n\n💡 Main !kuis untuk dapat ${config.gamePoints} poin!\n🎯 100 Poin = Real VIP`;
    },

    login: async (userId, chatType, args) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Chat Pribadi (Japri)!';
        if (userId === YOUR_NUMBER) return '✅ Anda Root Admin permanen! Tidak perlu login.';
        const [username, password] = args;
        if (!username || !password) return '❌ Format: !login <username> <password>';
        if (password !== config.admin.password) return '❌ Password salah!';
        const sessionData = { username, timestamp: Date.now(), sessionExpiry: Date.now() + (3600000 * 24) };
        authenticatedAdmins.set(userId, sessionData);
        await db.updateUser(userId, { username: username, role: 'operational_admin' });
        return `✅ *LOGIN BERHASIL!*\n\n👤 Username: ${username}\n⭐ Role: Operational Admin\n⏰ Expired: ${new Date(sessionData.sessionExpiry).toLocaleString('id-ID')}`;
    },

    ai: async (userId, chatType, args) => {
        const prompt = args.join(' ');
        if (!prompt) return '❌ Format: !ai <pertanyaan>';
        const user = await getUserData(userId);
        if (user.isBanned) return '🚫 Akun dibanned!';
        let limit = (user.role === 'root_admin' || user.role === 'admin' || user.role === 'operational_admin') ? Infinity : (config.aiLimits[user.role] || 5);
        if (user.vipType === 'fasttrack') limit = config.vip.fastTrack.dailyLimit;
        else if (user.vipType === 'real_vip') limit = Math.max(Math.floor(config.vip.realVip.limitPercentage * user.points), config.aiLimits.real_vip);
        if (user.aiUsedToday >= limit && limit !== Infinity) return `⚠️ *LIMIT AI HABIS!*\n\n📊 ${user.aiUsedToday}/${limit}\n🕐 Reset: 00:00 WIB`;
        try {
            const result = await aiService.generateResponse(prompt);
            await db.updateUser(userId, { aiUsedToday: (user.aiUsedToday || 0) + 1 });
            return `🤖 *7AI RESPONSE* (via ${result.provider.toUpperCase()})\n\n${result.text}\n\n📊 AI: ${(user.aiUsedToday || 0) + 1}/${limit === Infinity ? '∞' : limit}`;
        } catch (error) {
            return `❌ AI Error: ${error.message}`;
        }
    },

    kuis: async (userId) => {
        const questions = [
            { q: 'Apa ibu kota Indonesia?', a: 'jakarta' },
            { q: 'Berapa 12 x 5?', a: '60' },
            { q: 'Siapa presiden pertama Indonesia?', a: 'soekarno' },
            { q: 'Apa lambang kimia air?', a: 'h2o' },
            { q: 'Berapa sisi segitiga?', a: '3' }
        ];
        const random = questions[Math.floor(Math.random() * questions.length)];
        await db.updateUser(userId, { lastQuestion: random.q, lastAnswer: random.a.toLowerCase(), quizActive: true });
        return `🎮 *KUIS* (+${config.gamePoints} Poin)\n\n❓ ${random.q}\n\n📝 !hasil <jawaban>`;
    },

    hasil: async (userId, args) => {
        const answer = args.join(' ').toLowerCase().trim();
        if (!answer) return '❌ !hasil <jawaban>';
        const user = await db.getUser(userId);
        if (!user?.quizActive) return '❌ Ketik !kuis dulu!';
        const correctAnswer = user.lastAnswer;
        const isCorrect = answer === correctAnswer || correctAnswer.includes(answer) || answer.includes(correctAnswer);
        if (isCorrect) {
            const newPoints = (user.points || 0) + config.gamePoints;
            await db.updateUser(userId, { points: newPoints, quizActive: false, lastQuestion: null, lastAnswer: null });
            return `🎉 *BENAR!* +${config.gamePoints} Poin\n💰 Total: ${newPoints}`;
        } else {
            await db.updateUser(userId, { quizActive: false, lastQuestion: null, lastAnswer: null });
            return `❌ *SALAH!*\nJawaban: ${correctAnswer}`;
        }
    },

    leaderboard: async () => {
        const users = await db.getAllUsers();
        const sorted = Object.entries(users).sort(([,a], [,b]) => (b.points||0) - (a.points||0)).slice(0, 10);
        if (!sorted.length) return '📊 Belum ada data.';
        let text = '📊 *TOP 10*\n\n';
        sorted.forEach(([, u], i) => { text += `${i+1}. ${u.name} - ${u.points} poin\n`; });
        return text;
    },

    setgroup: async (userId, chatType, args, context) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        if (chatType !== 'group') return '⚠️ Gunakan di grup!';
        if (context?.groupId) {
            targetGroupId = context.groupId;
            await db.updateConfig({ targetGroupId: context.groupId });
            return '✅ Grup diatur!';
        }
        return '❌ Gagal.';
    },

    broadcast: async (userId, chatType, args) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Japri!';
        if (!targetGroupId) return '❌ Grup belum diset!';
        const message = args.join(' ');
        if (!message) return '❌ !broadcast <pesan>';
        if (isAdmin(userId)) {
            await sock.sendMessage(targetGroupId, { text: '📢 *PENGUMUMAN*\n\n' + message });
            return '✅ Terkirim!';
        }
        return '⏳ Admin akan review.';
    },

    setrole: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, newRole] = args;
        const targetId = await resolveUser(target);
        if (!targetId || !['officer','member','admin'].includes(newRole?.toLowerCase())) return '❌ Format: !setrole @user officer';
        await db.createUser(targetId);
        await db.updateUser(targetId, { role: newRole.toLowerCase() });
        return `✅ ${formatNumber(targetId)} → ${newRole.toUpperCase()}!`;
    },

    addvip: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, duration] = args;
        const targetId = await resolveUser(target);
        const days = parseInt(duration);
        if (!targetId || isNaN(days)) return '❌ Format: !addvip @user 2';
        const expiry = new Date(Date.now() + days*86400000);
        await db.createUser(targetId);
        await db.updateUser(targetId, { vipType: 'fasttrack', vipExpiredAt: expiry.toISOString() });
        return `⚡ VIP ${formatNumber(targetId)} ${days} hari!`;
    },

    banned: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const targetId = await resolveUser(args[0]);
        if (!targetId) return '❌ !banned @user';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: true });
        return `🚫 ${formatNumber(targetId)} dibanned!`;
    },

    unban: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const targetId = await resolveUser(args[0]);
        if (!targetId) return '❌ !unban @user';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: false });
        return `✅ ${formatNumber(targetId)} di-unban!`;
    },

    addpoint: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, points] = args;
        const targetId = await resolveUser(target);
        if (!targetId || isNaN(parseInt(points))) return '❌ !addpoint @user 50';
        const user = await db.getUser(targetId) || await db.createUser(targetId);
        const newPoints = (user.points || 0) + parseInt(points);
        await db.updateUser(targetId, { points: newPoints });
        return `✅ +${points} → ${formatNumber(targetId)}! Total: ${newPoints}`;
    },

    setusername: async (userId, chatType, args) => {
        const username = args[0];
        if (!username || username.length < 3) return '❌ Minimal 3 karakter!';
        const existing = await db.getUserByUsername(username);
        if (existing && existing.id !== userId) return '❌ Username sudah dipakai!';
        await db.updateUser(userId, { username: username.toLowerCase() });
        return `✅ Username: @${username.toLowerCase()}`;
    },

    aistatus: async (userId) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const info = aiService.getProviderInfo();
        return `🤖 *AI STATUS*\n🔄 ${info.current.toUpperCase()}\n✅ Groq: ${info.stats.groq.success}\n✅ Google: ${info.stats.google.success}`;
    }
};

// ==================== MESSAGE HANDLER ====================
async function handleMessage(message) {
    try {
        const { key, message: msg } = message;
        const userId = key.remoteJid;
        if (key.fromMe) return;
        const chatType = userId.endsWith('@g.us') ? 'group' : 'private';
        const text = msg?.conversation || msg?.extendedTextMessage?.text || '';
        await getUserData(userId);
        if (!text || !text.startsWith('!')) return;
        const [command, ...args] = text.slice(1).split(' ');
        const handler = commands[command.toLowerCase()];
        if (handler) {
            const response = await handler(userId, chatType, args, { groupId: chatType === 'group' ? userId : null });
            if (response && sock) await sock.sendMessage(userId, { text: response });
        }
    } catch (error) {
        consoleLog('Error: ' + error.message, 'error');
    }
}

// ==================== CRON JOBS ====================
function setupCronJobs() {
    cron.schedule('0 17 * * *', async () => {
        await db.bulkUpdateUsers(users => {
            Object.keys(users).forEach(uid => {
                users[uid].aiUsedToday = 0;
                if (users[uid].vipType === 'real_vip') {
                    users[uid].points = Math.max(0, (users[uid].points||0) - 50);
                    if (users[uid].points < 50) users[uid].vipType = 'none';
                }
                if (users[uid].vipType === 'fasttrack' && users[uid].vipExpiredAt && new Date(users[uid].vipExpiredAt) <= new Date()) {
                    users[uid].vipType = 'none';
                }
            });
            return users;
        });
    }, { timezone: 'Asia/Jakarta' });
}

// ==================== WHATSAPP CONNECTION ====================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: ['7AI Bot', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        syncFullHistory: false,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('\n📱 QR CODE READY! Buka /qr untuk pairing code\n');
        }

        if (connection === 'close') {
            currentQR = null;
            pairingMessage = '';
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            consoleLog('Connection closed: ' + (statusCode || 'unknown'), 'warning');
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            currentQR = null;
            pairingMessage = '✅ Bot Connected!';
            consoleLog('✅ BOT CONNECTED!', 'success');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') for (const msg of messages) await handleMessage(msg);
    });
}

// ==================== MAIN ====================
async function main() {
    console.log('\n🚀 7AI Bot Starting...\n');
    
    app.listen(PORT, '0.0.0.0', () => {
        consoleLog(`🌐 Server: http://0.0.0.0:${PORT}`, 'success');
        consoleLog(`📱 Pairing: http://0.0.0.0:${PORT}/qr`, 'success');
    });

    await initializeDatabase();
    setupCronJobs();
    await connectToWhatsApp();
    botStartTime = Date.now();
}

main().catch(console.error);

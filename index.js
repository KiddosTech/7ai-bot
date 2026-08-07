import express from 'express';
import http from 'http';
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
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== EXPRESS SERVER ====================
const app = express();
const PORT = process.env.PORT || 3000;
let botStartTime = Date.now();
let currentQR = null; // Simpan QR Code untuk web
let qrTimestamp = null;

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

// ==================== QR CODE WEB PAGE ====================
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
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', async (req, res) => {
    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR, {
                width: 400,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            });
            
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>🤖 7AI Bot - Scan QR Code</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        * { margin: 0; padding: 0; box-sizing: border-box; }
                        body { 
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
                            background: rgba(255,255,255,0.1);
                            backdrop-filter: blur(10px);
                            border-radius: 20px;
                            padding: 30px;
                            max-width: 450px;
                            width: 100%;
                        }
                        h2 { 
                            color: #fff;
                            margin-bottom: 10px;
                            font-size: 24px;
                        }
                        .subtitle {
                            color: #e0e0e0;
                            margin-bottom: 20px;
                            font-size: 14px;
                        }
                        img { 
                            max-width: 300px; 
                            width: 100%;
                            border: 5px solid white; 
                            border-radius: 15px; 
                            padding: 15px; 
                            background: white;
                            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                        }
                        .info {
                            margin-top: 20px;
                            padding: 15px;
                            background: rgba(255,255,255,0.2);
                            border-radius: 10px;
                            font-size: 13px;
                            line-height: 1.6;
                        }
                        .info strong {
                            color: #ffeb3b;
                        }
                        .btn {
                            display: inline-block;
                            background: white;
                            color: #764ba2;
                            border: none;
                            padding: 12px 30px;
                            border-radius: 25px;
                            cursor: pointer;
                            margin-top: 20px;
                            font-weight: bold;
                            text-decoration: none;
                            transition: all 0.3s;
                        }
                        .btn:hover {
                            transform: scale(1.05);
                            box-shadow: 0 5px 20px rgba(0,0,0,0.3);
                        }
                        .timer {
                            color: #ffeb3b;
                            font-size: 12px;
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
                        <p class="subtitle">Scan QR Code untuk menghubungkan bot</p>
                        <img src="${qrImage}" alt="QR Code">
                        <div class="info">
                            <p>📱 <strong>WhatsApp</strong> > Perangkat Tertaut > <strong>Tautkan Perangkat</strong></p>
                            <p>📷 Arahkan kamera ke QR Code di atas</p>
                        </div>
                        <a href="/qr" class="btn">🔄 Refresh QR Code</a>
                        <p class="timer">⏰ Halaman auto-refresh setiap 30 detik</p>
                        <p class="timer">QR generated: ${qrTimestamp}</p>
                    </div>
                </body>
                </html>
            `);
        } catch (error) {
            res.send('<h2>Error generating QR</h2><p>Refresh page</p>');
        }
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>🤖 7AI Bot - Waiting</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white; 
                        font-family: 'Segoe UI', Arial, sans-serif; 
                        text-align: center; 
                        padding: 50px 20px;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    .container {
                        background: rgba(255,255,255,0.1);
                        backdrop-filter: blur(10px);
                        border-radius: 20px;
                        padding: 40px;
                        max-width: 450px;
                    }
                    h2 { margin-bottom: 20px; }
                    .spinner {
                        border: 4px solid rgba(255,255,255,0.3);
                        border-top: 4px solid white;
                        border-radius: 50%;
                        width: 50px;
                        height: 50px;
                        animation: spin 1s linear infinite;
                        margin: 20px auto;
                    }
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    .status {
                        margin: 20px 0;
                        padding: 15px;
                        background: rgba(255,255,255,0.2);
                        border-radius: 10px;
                    }
                </style>
                <script>
                    setTimeout(() => location.reload(), 5000);
                </script>
            </head>
            <body>
                <div class="container">
                    <h2>🤖 7AI Bot</h2>
                    <div class="spinner"></div>
                    <p>⏳ Menunggu QR Code...</p>
                    <div class="status">
                        <p>Status: <strong>Starting</strong></p>
                        <p>Halaman auto-refresh setiap 5 detik</p>
                    </div>
                    <p style="margin-top:20px;font-size:12px;opacity:0.7;">
                        Bot: ${config.botName} v${config.version}
                    </p>
                </div>
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
        if (userId !== YOUR_NUMBER && sock) {
            sock.sendMessage(userId, { text: `👋 *Selamat datang di 7AI!*\n\nKamu otomatis terdaftar sebagai *Member*.\n\n📋 Ketik *!menu* untuk lihat fitur.\n🎮 Ketik *!kuis* untuk main game (+${config.gamePoints} poin)!\n🤖 Ketik *!ai <pertanyaan>* untuk tanya AI.\n\n💰 Limit AI: 5x/hari\n💎 Upgrade ke VIP untuk limit lebih besar!` }).catch(() => {});
        }
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
        consoleLog(`Admin login: ${formatNumber(userId)} as ${username}`, 'success');
        return `✅ *LOGIN BERHASIL!*\n\n👤 Username: ${username}\n⭐ Role: Operational Admin\n⏰ Expired: ${new Date(sessionData.sessionExpiry).toLocaleString('id-ID')}\n\nGunakan !menu untuk lihat command admin.`;
    },

    ai: async (userId, chatType, args) => {
        const prompt = args.join(' ');
        if (!prompt) return '❌ Format: !ai <pertanyaan>';
        const user = await getUserData(userId);
        if (user.isBanned) return '🚫 Akun dibanned!';
        let limit = (user.role === 'root_admin' || user.role === 'admin' || user.role === 'operational_admin') ? Infinity : (config.aiLimits[user.role] || 5);
        if (user.vipType === 'fasttrack') limit = config.vip.fastTrack.dailyLimit;
        else if (user.vipType === 'real_vip') limit = Math.max(Math.floor(config.vip.realVip.limitPercentage * user.points), config.aiLimits.real_vip);
        if (user.aiUsedToday >= limit && limit !== Infinity) return `⚠️ *LIMIT AI HABIS!*\n\n📊 ${user.aiUsedToday}/${limit}\n🕐 Reset: 00:00 WIB\n\n💡 Upgrade ke VIP: !buyvip`;
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
            { q: 'Berapa sisi segitiga?', a: '3' },
            { q: 'Sebutkan planet terbesar!', a: 'jupiter' },
            { q: 'Apa bahasa Inggris "sekolah"?', a: 'school' },
            { q: 'Berapa 100 : 4?', a: '25' },
            { q: 'Siapa penemu lampu?', a: 'thomas edison' },
            { q: 'Apa kepanjangan NKRI?', a: 'negara kesatuan republik indonesia' }
        ];
        const random = questions[Math.floor(Math.random() * questions.length)];
        await db.updateUser(userId, { lastQuestion: random.q, lastAnswer: random.a.toLowerCase(), quizActive: true });
        const user = await getUserData(userId);
        return `🎮 *KUIS 7AI* (+${config.gamePoints} Poin)\n\n❓ ${random.q}\n\n📝 Jawab: !hasil <jawabanmu>\n💰 Poin: ${user.points}`;
    },

    hasil: async (userId, args) => {
        const answer = args.join(' ').toLowerCase().trim();
        if (!answer) return '❌ Format: !hasil <jawabanmu>';
        const user = await db.getUser(userId);
        if (!user || !user.quizActive) return '❌ Kamu belum mulai kuis! Ketik !kuis dulu.';
        const correctAnswer = user.lastAnswer.toLowerCase().trim();
        const isCorrect = answer === correctAnswer || correctAnswer.includes(answer) || answer.includes(correctAnswer);
        if (isCorrect) {
            const newPoints = (user.points || 0) + config.gamePoints;
            await db.updateUser(userId, { points: newPoints, lastQuestion: null, lastAnswer: null, quizActive: false });
            consoleLog(`${formatNumber(userId)} jawab kuis benar! +${config.gamePoints} poin`, 'game');
            return `🎉 *BENAR!* +${config.gamePoints} Poin\n\n✅ Jawaban: ${user.lastAnswer}\n💰 Total Poin: ${newPoints}\n\nKetik !kuis untuk main lagi!`;
        } else {
            await db.updateUser(userId, { lastQuestion: null, lastAnswer: null, quizActive: false });
            return `❌ *SALAH!*\n\nJawaban benar: ${user.lastAnswer}\n\nKetik !kuis untuk coba lagi!`;
        }
    },

    leaderboard: async () => {
        const users = await db.getAllUsers();
        const sorted = Object.entries(users).sort(([,a], [,b]) => (b.points||0) - (a.points||0)).slice(0, 10);
        if (!sorted.length) return '📊 *LEADERBOARD*\n\nBelum ada data poin. Mainkan !kuis!';
        let text = '📊 *TOP 10 POIN TERTINGGI*\n━━━━━━━━━━━━━━━━━━\n\n';
        sorted.forEach(([, u], i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
            text += `${medal} *${u.name}*\n   💰 ${u.points} poin | ⭐ ${u.role}\n`;
            if (u.username) text += `   👤 @${u.username}\n`;
            text += '\n';
        });
        return text;
    },

    setgroup: async (userId, chatType, args, context) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        if (chatType !== 'group') return '⚠️ Gunakan di dalam grup!';
        if (context?.groupId) {
            targetGroupId = context.groupId;
            await db.updateConfig({ targetGroupId: context.groupId });
            const groupMeta = await sock.groupMetadata(context.groupId).catch(() => null);
            const groupName = groupMeta ? groupMeta.subject : 'Grup';
            return `✅ *GRUP UTAMA DIATUR!*\n\n👥 ${groupName}\n📱 ${context.groupId}`;
        }
        return '❌ Gagal.';
    },

    broadcast: async (userId, chatType, args) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Japri!';
        if (!targetGroupId) return '❌ Grup belum diset! Gunakan !setgroup di grup.';
        const message = args.join(' ');
        if (!message) return '❌ Format: !broadcast <pesan>';
        if (isAdmin(userId)) {
            await sock.sendMessage(targetGroupId, { text: `📢 *PENGUMUMAN ADMIN*\n━━━━━━━━━━━━━━━━━━\n\n${message}\n\n━━━━━━━━━━━━━━━━━━\n👤 Admin 7AI\n🕐 ${getCurrentTime()} WIB` });
            consoleLog('Admin broadcast sent', 'broadcast');
            return '✅ Pengumuman terkirim!';
        }
        const broadcastId = `BRC${Date.now().toString(36).toUpperCase()}`;
        broadcastQueue.push({ id: broadcastId, userId, message });
        await sock.sendMessage(YOUR_NUMBER, { text: `📩 *PENGAJUAN BROADCAST*\n🆔 ${broadcastId}\n👤 ${formatNumber(userId)}\n💬 "${message}"\n\n✅ !acc ${broadcastId}\n❌ !reject ${broadcastId}` });
        return `⏳ Pengajuan dikirim ke Admin. ID: ${broadcastId}`;
    },

    acc: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const id = args[0];
        const index = broadcastQueue.findIndex(i => i.id === id);
        if (index === -1) return '❌ Tidak ditemukan!';
        const bc = broadcastQueue[index];
        broadcastQueue.splice(index, 1);
        await sock.sendMessage(targetGroupId, { text: `📢 *PENGUMUMAN*\n\n${bc.message}\n\n✅ Disetujui Admin` });
        await sock.sendMessage(bc.userId, { text: `✅ Pengajuan ${id} DISETUJUI & dikirim!` });
        return `✅ Broadcast ${id} dikirim!`;
    },

    reject: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const id = args[0];
        const index = broadcastQueue.findIndex(i => i.id === id);
        if (index === -1) return '❌ Tidak ditemukan!';
        const bc = broadcastQueue[index];
        broadcastQueue.splice(index, 1);
        await sock.sendMessage(bc.userId, { text: `❌ Pengajuan ${id} DITOLAK Admin.` });
        return `❌ Broadcast ${id} ditolak.`;
    },

    claimvip: async (userId, chatType) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Japri!';
        const user = await getUserData(userId);
        if (user.vipType !== 'none') return '❌ Anda sudah VIP!';
        if (user.points < 100) return `❌ Poin kurang! Butuh 100. Poin: ${user.points}`;
        await db.updateUser(userId, { points: user.points - 100, vipType: 'real_vip' });
        consoleLog(`${formatNumber(userId)} klaim Real VIP`, 'success');
        return `🎉 *REAL VIP AKTIF!*\n\n💰 Poin: ${user.points - 100}\n🤖 Limit: 50% poin (min. 50/hari)\n⚠️ Biaya: 50 poin/hari\n\nTetap main !kuis ya!`;
    },

    buyvip: async (userId, chatType) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Japri!';
        return `⚡ *VIP FAST-TRACK*\n\n💵 Biaya: Rp2.000 / 2 Hari\n🤖 Limit: 25x/hari\n⏱️ Durasi: 2 Hari\n\n📋 Cara Beli:\n1. Transfer Rp2.000 ke Admin\n2. Konfirmasi ke Admin\n3. Admin aktifkan dengan !addvip\n\n📞 wa.me/${formatNumber(YOUR_NUMBER)}`;
    },

    setrole: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, newRole] = args;
        if (!target || !newRole) return '❌ Format: !setrole <@user/username> <officer/member/admin>\n\nContoh:\n!setrole @6281234567890 officer\n!setrole budi officer';
        const validRoles = ['officer', 'member', 'admin', 'operational_admin'];
        if (!validRoles.includes(newRole.toLowerCase())) return `❌ Role tidak valid! Pilih: ${validRoles.join(', ')}`;
        const targetId = await resolveUser(target);
        if (!targetId) return '❌ User tidak ditemukan!';
        await db.createUser(targetId);
        await db.updateUser(targetId, { role: newRole.toLowerCase() });
        consoleLog(`${formatNumber(userId)} set role ${newRole} → ${formatNumber(targetId)}`, 'success');
        await sock.sendMessage(targetId, { text: `🎉 Role kamu diubah jadi *${newRole.toUpperCase()}*!\n\nCek !profile untuk lihat perubahan.` }).catch(() => {});
        return `✅ ${formatNumber(targetId)} → *${newRole.toUpperCase()}*!`;
    },

    addvip: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, duration] = args;
        if (!target || !duration) return '❌ Format: !addvip <@user/username> <hari>\n\nContoh:\n!addvip @6281234567890 2\n!addvip budi 2';
        const targetId = await resolveUser(target);
        const days = parseInt(duration);
        if (!targetId || isNaN(days) || days < 1) return '❌ Format salah!';
        const expiryDate = new Date(Date.now() + days * 86400000);
        await db.createUser(targetId);
        await db.updateUser(targetId, { vipType: 'fasttrack', vipExpiredAt: expiryDate.toISOString() });
        await sock.sendMessage(targetId, { text: `🎉 *VIP FAST-TRACK AKTIF!*\n\n⚡ Durasi: ${days} hari\n📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}\n🤖 Limit: 25x/hari\n\nSelamat menikmati!` }).catch(() => {});
        return `⚡ VIP Fast-Track → ${formatNumber(targetId)} selama *${days} hari*!\n📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}`;
    },

    banned: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const target = args[0];
        if (!target) return '❌ Format: !banned <@user/username>';
        const targetId = await resolveUser(target);
        if (!targetId) return '❌ User tidak ditemukan!';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: true });
        consoleLog(`${formatNumber(userId)} banned ${formatNumber(targetId)}`, 'warning');
        return `🚫 ${formatNumber(targetId)} *DIBANNED!*`;
    },

    unban: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const target = args[0];
        if (!target) return '❌ Format: !unban <@user/username>';
        const targetId = await resolveUser(target);
        if (!targetId) return '❌ User tidak ditemukan!';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: false });
        await sock.sendMessage(targetId, { text: '✅ Kamu telah di-unban! Bisa pakai bot lagi.' }).catch(() => {});
        return `✅ ${formatNumber(targetId)} *DI-UNBAN!*`;
    },

    addpoint: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, points] = args;
        if (!target || !points) return '❌ Format: !addpoint <@user/username> <jumlah>\n\nContoh:\n!addpoint @6281234567890 50\n!addpoint budi 50';
        const targetId = await resolveUser(target);
        if (!targetId || isNaN(parseInt(points))) return '❌ Format salah!';
        const user = await db.getUser(targetId) || await db.createUser(targetId);
        const newPoints = (user.points || 0) + parseInt(points);
        await db.updateUser(targetId, { points: newPoints });
        await sock.sendMessage(targetId, { text: `💰 *+${points} Poin!*\n\nTotal: ${newPoints} poin\n\nCek !poin` }).catch(() => {});
        return `✅ +${points} poin → ${formatNumber(targetId)}! Total: ${newPoints}`;
    },

    setusername: async (userId, chatType, args) => {
        const username = args[0];
        if (!username) return '❌ Format: !setusername <nama>';
        if (username.length < 3) return '❌ Minimal 3 karakter!';
        const existing = await db.getUserByUsername(username);
        if (existing && existing.id !== userId) return '❌ Username sudah dipakai!';
        await db.updateUser(userId, { username: username.toLowerCase() });
        return `✅ Username: *@${username.toLowerCase()}*`;
    },

    resetlimit: async (userId) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        let count = 0;
        await db.bulkUpdateUsers(users => {
            Object.keys(users).forEach(k => { if (users[k].aiUsedToday > 0) { users[k].aiUsedToday = 0; count++; } });
            return users;
        });
        return `✅ Limit ${count} user direset!`;
    },

    aistatus: async (userId) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const info = aiService.getProviderInfo();
        return `🤖 *AI STATUS*\n\n🔄 Provider: ${info.current.toUpperCase()}\n📊 Prioritas: ${info.priority}\n\n🔹 *Groq:* ✅${info.stats.groq.success} | ❌${info.stats.groq.failed} | Keys: ${info.groqKeys}\n🔹 *Google:* ✅${info.stats.google.success} | ❌${info.stats.google.failed} | Keys: ${info.googleKeys}`;
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

        const user = await getUserData(userId);
        if (msg?.pushName && user.name === 'Siswa 7A' && userId !== YOUR_NUMBER) {
            await db.updateUser(userId, { name: msg.pushName });
        }

        if (!text || !text.startsWith('!')) return;

        const [command, ...args] = text.slice(1).split(' ');
        const handler = commands[command.toLowerCase()];

        if (handler) {
            const response = await handler(userId, chatType, args, { groupId: chatType === 'group' ? userId : null });
            if (response && sock) {
                await sock.sendMessage(userId, { text: response });
            }
        }
    } catch (error) {
        consoleLog('Handler error: ' + error.message, 'error');
    }
}

// ==================== CRON JOBS ====================
function setupCronJobs() {
    cron.schedule('0 17 * * *', async () => {
        consoleLog('Daily reset (00:00 WIB)...', 'cron');
        let realVIPLost = 0;
        let fastTrackExpired = 0;

        await db.bulkUpdateUsers(users => {
            Object.keys(users).forEach(uid => {
                const u = users[uid];
                u.aiUsedToday = 0;
                if (u.vipType === 'real_vip') {
                    u.points = Math.max(0, (u.points || 0) - 50);
                    if (u.points < 50) {
                        u.vipType = 'none';
                        realVIPLost++;
                        if (sock) sock.sendMessage(uid, { text: '⚠️ *REAL VIP DICABUT*\n\nPoin tidak cukup untuk biaya harian (50 poin).\n\nKumpulkan 100 poin lagi untuk klaim ulang!' }).catch(() => {});
                    }
                }
                if (u.vipType === 'fasttrack' && u.vipExpiredAt && new Date(u.vipExpiredAt) <= new Date()) {
                    u.vipType = 'none';
                    u.vipExpiredAt = null;
                    fastTrackExpired++;
                    if (sock) sock.sendMessage(uid, { text: '⚠️ *VIP FAST-TRACK BERAKHIR*\n\nMasa aktif VIP habis. Hubungi Admin untuk perpanjang.' }).catch(() => {});
                }
            });
            return users;
        });

        consoleLog(`Reset done - VIP lost: ${realVIPLost}, Expired: ${fastTrackExpired}`, 'cron');

        const now = Date.now();
        for (const [adminId, session] of authenticatedAdmins) {
            if (now > session.sessionExpiry) authenticatedAdmins.delete(adminId);
        }
    }, { timezone: 'Asia/Jakarta' });
}

// ==================== WHATSAPP CONNECTION ====================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ['7AI Bot', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        syncFullHistory: false,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 QR CODE READY! Buka /qr untuk scan\n');
            qrcode.generate(qr, { small: true });
            // Simpan QR untuk web
            currentQR = qr;
            qrTimestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            consoleLog('QR Code generated - open /qr to scan', 'success');
        }

        if (connection === 'close') {
            currentQR = null;
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            consoleLog('Connection closed: ' + (statusCode || 'unknown'), 'warning');
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                consoleLog('Logged out! Hapus auth_info_baileys & restart.', 'error');
            }
        } else if (connection === 'open') {
            consoleLog('✅ BOT CONNECTED!', 'success');
            consoleLog(`🤖 ${config.botName} ready!`, 'success');
            consoleLog(`🌐 QR Web: http://0.0.0.0:${PORT}/qr`, 'success');
            currentQR = null; // Hapus QR setelah connect
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                await handleMessage(msg);
            }
        }
    });
}

// ==================== MAIN ====================
async function main() {
    console.log('\n==================================================');
    console.log(`🚀 ${config.botName} Starting...`);
    console.log('==================================================\n');

    // Start Express server FIRST
    app.listen(PORT, '0.0.0.0', () => {
        consoleLog(`🌐 Server ready: http://0.0.0.0:${PORT}`, 'success');
        consoleLog(`📱 QR Code page: http://0.0.0.0:${PORT}/qr`, 'success');
    });

    await initializeDatabase();
    setupCronJobs();
    await connectToWhatsApp();
    botStartTime = Date.now();
}

main().catch(console.error);

// ╔══════════════════════════════════════════════════╗
// ║  7AI BOT - RAILWAY HEALTHCHECK FIX VERSION      ║
// ╚══════════════════════════════════════════════════╝

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== HEALTH SERVER (DIBUAT PALING AWAL) ====================
const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => {
    res.json({ status: 'online', bot: '7AI', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// LISTEN DI SEMUA INTERFACE
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ HEALTH SERVER READY ON PORT ${PORT}`);
    console.log(`✅ http://0.0.0.0:${PORT}/health`);
});

server.on('error', (err) => {
    console.error('Server error:', err);
    // Coba port lain kalau PORT sibuk
    if (err.code === 'EADDRINUSE') {
        const altPort = parseInt(PORT) + 1;
        server.listen(altPort, '0.0.0.0', () => {
            console.log(`✅ HEALTH SERVER ON ALT PORT ${altPort}`);
        });
    }
});

// ==================== GLOBAL STATE ====================
const authenticatedAdmins = new Map();
const broadcastQueue = [];
let targetGroupId = null;
let sock = null;
let botStartTime = Date.now();
let isWhatsAppReady = false;

// ==================== YOUR ADMIN NUMBER ====================
const YOUR_NUMBER = config.admin.rootNumber;
const YOUR_NAME = 'Root Admin';

// ==================== LOGGER ====================
const logger = pino({ level: 'silent' });

const consoleLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
    const emoji = { info: '📘', success: '✅', error: '❌', warning: '⚠️', ai: '🤖', cron: '🕐' };
    console.log(`${emoji[type] || '📘'} [${timestamp}] ${message}`);
};

// ==================== DATABASE ====================
async function initializeDatabase() {
    try {
        const dbDir = path.join(__dirname, 'database');
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        await db.init();
        const appConfig = await db.getConfig();
        targetGroupId = appConfig.targetGroupId;
        consoleLog('Database OK', 'success');
    } catch (error) {
        consoleLog('DB Error: ' + error.message, 'error');
    }
}

// ==================== HELPERS ====================
function isAdmin(userId) {
    if (userId === YOUR_NUMBER) return true;
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
        consoleLog(`New user: ${formatNumber(userId)}`, 'register');
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
    return input + '@s.whatsapp.net';
}

function getCurrentTime() {
    return new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
}

// ==================== COMMANDS ====================
const commands = {
    menu: async (userId) => {
        const user = await getUserData(userId);
        const adminMenu = isAdmin(userId) ? '\n👑 *ADMIN*\n📢 !broadcast | ⚙️ !setgroup\n👥 !setrole | 💎 !addvip\n🚫 !banned | ✅ !unban\n💰 !addpoint | 🔄 !resetlimit\n🤖 !aistatus' : '';
        return `🤖 *7A INTELLIGENCE (7AI)*\n\n👤 ${user.name}\n⭐ ${user.role.toUpperCase()}\n💰 ${user.points} poin\n━━━━━━━━━━━━━━━━━━\n\n📋 *MENU*\n🤖 !ai <tanya>\n👤 !profile (Japri)\n🎮 !kuis (+5 poin)\n📊 !leaderboard\n💎 !claimvip\n⚡ !buyvip\n👤 !setusername <name>${adminMenu}`;
    },

    profile: async (userId, chatType) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Chat Pribadi (Japri)!';
        const user = await getUserData(userId);
        let limit = (user.role === 'root_admin' || user.role === 'admin' || user.role === 'operational_admin') ? '∞' : (config.aiLimits[user.role] || 5);
        return `👤 *PROFIL*\n\n📱 ${formatNumber(userId)}\n📝 ${user.name}\n⭐ ${user.role.toUpperCase()}\n💰 ${user.points} poin\n🤖 ${user.aiUsedToday}/${limit}`;
    },

    ai: async (userId, chatType, args) => {
        const prompt = args.join(' ');
        if (!prompt) return '❌ !ai <pertanyaan>';
        const user = await getUserData(userId);
        if (user.isBanned) return '🚫 Dibanned!';
        let limit = (user.role === 'root_admin' || user.role === 'admin' || user.role === 'operational_admin') ? Infinity : (config.aiLimits[user.role] || 5);
        if (user.aiUsedToday >= limit && limit !== Infinity) return '⚠️ Limit habis!';
        try {
            const result = await aiService.generateResponse(prompt);
            await db.updateUser(userId, { aiUsedToday: (user.aiUsedToday || 0) + 1 });
            return `🤖 *7AI* (via ${result.provider.toUpperCase()})\n\n${result.text}`;
        } catch (error) {
            return `❌ ${error.message}`;
        }
    },

    kuis: async (userId) => {
        const questions = [
            { q: 'Apa ibu kota Indonesia?', a: 'jakarta' },
            { q: 'Berapa 12 x 5?', a: '60' },
            { q: 'Siapa presiden pertama Indonesia?', a: 'soekarno' },
            { q: 'Apa lambang kimia air?', a: 'h2o' }
        ];
        const random = questions[Math.floor(Math.random() * questions.length)];
        await db.updateUser(userId, { lastQuestion: random.q, lastAnswer: random.a.toLowerCase(), quizActive: true });
        return `🎮 *KUIS* (+5 Poin)\n\n❓ ${random.q}\n\n📝 !hasil <jawaban>`;
    },

    hasil: async (userId, args) => {
        const answer = args.join(' ').toLowerCase().trim();
        if (!answer) return '❌ !hasil <jawaban>';
        const user = await db.getUser(userId);
        if (!user?.quizActive) return '❌ Ketik !kuis dulu!';
        const correctAnswer = user.lastAnswer;
        const isCorrect = answer === correctAnswer || correctAnswer.includes(answer) || answer.includes(correctAnswer);
        if (isCorrect) {
            const newPoints = (user.points || 0) + 5;
            await db.updateUser(userId, { points: newPoints, quizActive: false, lastQuestion: null, lastAnswer: null });
            return `🎉 BENAR! +5 Poin\n💰 Total: ${newPoints}`;
        } else {
            await db.updateUser(userId, { quizActive: false, lastQuestion: null, lastAnswer: null });
            return `❌ SALAH!\nJawaban: ${correctAnswer}`;
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
        if (!targetId) return '❌ Format: !setrole <@user/username> <role>';
        await db.createUser(targetId);
        await db.updateUser(targetId, { role: newRole.toLowerCase() });
        return `✅ ${formatNumber(targetId)} → ${newRole.toUpperCase()}!`;
    },

    addvip: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, duration] = args;
        const targetId = await resolveUser(target);
        const days = parseInt(duration);
        if (!targetId || isNaN(days)) return '❌ Format: !addvip <@user/username> <hari>';
        const expiryDate = new Date(Date.now() + days * 86400000);
        await db.createUser(targetId);
        await db.updateUser(targetId, { vipType: 'fasttrack', vipExpiredAt: expiryDate.toISOString() });
        return `⚡ VIP ${formatNumber(targetId)} ${days} hari!`;
    },

    banned: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const targetId = await resolveUser(args[0]);
        if (!targetId) return '❌ Format: !banned <@user/username>';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: true });
        return `🚫 ${formatNumber(targetId)} dibanned!`;
    },

    unban: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const targetId = await resolveUser(args[0]);
        if (!targetId) return '❌ Format: !unban <@user/username>';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: false });
        return `✅ ${formatNumber(targetId)} di-unban!`;
    },

    addpoint: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, points] = args;
        const targetId = await resolveUser(target);
        if (!targetId || isNaN(parseInt(points))) return '❌ Format: !addpoint <@user/username> <jumlah>';
        const user = await db.getUser(targetId) || await db.createUser(targetId);
        const newPoints = (user.points || 0) + parseInt(points);
        await db.updateUser(targetId, { points: newPoints });
        return `✅ +${points} → ${formatNumber(targetId)}! Total: ${newPoints}`;
    },

    setusername: async (userId, chatType, args) => {
        const username = args[0];
        if (!username || username.length < 3) return '❌ Username minimal 3 karakter!';
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
        if (qr) { console.log('\n📱 SCAN QR:\n'); qrcode.generate(qr, { small: true }); }
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            consoleLog('✅ BOT CONNECTED!', 'success');
            isWhatsAppReady = true;
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
    
    // Database & WhatsApp dijalankan di background
    // Health server sudah jalan duluan
    
    initializeDatabase().catch(err => consoleLog('DB Error: ' + err.message, 'error'));
    connectToWhatsApp().catch(err => consoleLog('WA Error: ' + err.message, 'error'));
}

// Start!
main();

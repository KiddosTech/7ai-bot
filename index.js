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

// ==================== EXPRESS SERVER (START PERTAMA KALI) ====================
const app = express();
const PORT = process.env.PORT || 3000;

// Flag buat cek bot udah siap
let isBotReady = false;

// Health check - SELALU RETURN OK
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Root endpoint
app.get('/', (req, res) => {
    const info = aiService.getProviderInfo();
    res.json({
        status: isBotReady ? 'online' : 'starting',
        bot: config.botName,
        version: config.version,
        provider: info.current,
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
        timestamp: new Date().toISOString()
    });
});

// ==================== GLOBAL STATE ====================
const authenticatedAdmins = new Map();
const broadcastQueue = [];
let targetGroupId = null;
let sock = null;
let botStartTime = Date.now();

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
            return `🎉 *BENAR!* +${config.gamePoints} Poin\n\n✅ Jawaban: ${user.lastAnswer}\n💰 Total Poin: ${newPoints}\n\nKetik !kuis lagi!`;
        } else {
            await db.updateUser(userId, { lastQuestion: null, lastAnswer: null, quizActive: false });
            return `❌ *SALAH!*\n\nJawaban benar: ${user.lastAnswer}\n\nKetik !kuis untuk coba lagi!`;
        }
    },

    leaderboard: async () => {
        const users = await db.getAllUsers();
        const sorted = Object.entries(users).sort(([,a], [,b]) => (b.points||0) - (a.points||0)).slice(0, 10);
        if (!sorted.length) return '📊 *LEADERBOARD*\n\nBelum ada data. Mainkan !kuis!';
        let text = '📊 *TOP 10 POIN*\n━━━━━━━━━━━━━━━━━━\n\n';
        sorted.forEach(([, u], i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
            text += `${medal} *${u.name}*\n   💰 ${u.points} poin | ⭐ ${u.role}\n\n`;
        });
        return text;
    },

    setgroup: async (userId, chatType, args, context) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        if (chatType !== 'group') return '⚠️ Gunakan di dalam grup!';
        if (context?.groupId) {
            targetGroupId = context.groupId;
            await db.updateConfig({ targetGroupId: context.groupId });
            return '✅ Grup utama diatur!';
        }
        return '❌ Gagal.';
    },

    broadcast: async (userId, chatType, args) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Japri!';
        if (!targetGroupId) return '❌ Grup belum diset!';
        const message = args.join(' ');
        if (!message) return '❌ Format: !broadcast <pesan>';
        if (isAdmin(userId)) {
            await sock.sendMessage(targetGroupId, { text: `📢 *PENGUMUMAN ADMIN*\n\n${message}\n\n👤 Admin 7AI\n🕐 ${getCurrentTime()} WIB` });
            return '✅ Terkirim!';
        }
        const broadcastId = `BRC${Date.now().toString(36).toUpperCase()}`;
        broadcastQueue.push({ id: broadcastId, userId, message });
        await sock.sendMessage(YOUR_NUMBER, { text: `📩 *PENGAJUAN*\n🆔 ${broadcastId}\n👤 ${formatNumber(userId)}\n💬 "${message}"\n\n!acc ${broadcastId} | !reject ${broadcastId}` });
        return `⏳ Dikirim ke Admin. ID: ${broadcastId}`;
    },

    acc: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const id = args[0];
        const index = broadcastQueue.findIndex(i => i.id === id);
        if (index === -1) return '❌ Tidak ditemukan!';
        const bc = broadcastQueue[index];
        broadcastQueue.splice(index, 1);
        await sock.sendMessage(targetGroupId, { text: `📢 *PENGUMUMAN*\n\n${bc.message}\n\n✅ Disetujui Admin` });
        await sock.sendMessage(bc.userId, { text: `✅ Pengajuan ${id} DISETUJUI!` });
        return `✅ Broadcast ${id} dikirim!`;
    },

    reject: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const id = args[0];
        const index = broadcastQueue.findIndex(i => i.id === id);
        if (index === -1) return '❌ Tidak ditemukan!';
        const bc = broadcastQueue[index];
        broadcastQueue.splice(index, 1);
        await sock.sendMessage(bc.userId, { text: `❌ Pengajuan ${id} DITOLAK.` });
        return `❌ Broadcast ${id} ditolak.`;
    },

    claimvip: async (userId, chatType) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Japri!';
        const user = await getUserData(userId);
        if (user.vipType !== 'none') return '❌ Anda sudah VIP!';
        if (user.points < 100) return `❌ Poin kurang! Butuh 100. Poin: ${user.points}`;
        await db.updateUser(userId, { points: user.points - 100, vipType: 'real_vip' });
        return `🎉 *REAL VIP AKTIF!*\n\n💰 Poin: ${user.points - 100}\n🤖 Limit: 50% poin (min. 50/hari)\n⚠️ Biaya: 50 poin/hari`;
    },

    buyvip: async (userId, chatType) => {
        if (chatType !== 'private') return '⚠️ Gunakan via Japri!';
        return `⚡ *VIP FAST-TRACK*\n\n💵 Rp2.000 / 2 Hari\n🤖 Limit: 25x/hari\n\n📞 wa.me/${formatNumber(YOUR_NUMBER)}`;
    },

    setrole: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, newRole] = args;
        if (!target || !newRole) return '❌ Format: !setrole <@user/username> <officer/member/admin>';
        const targetId = await resolveUser(target);
        if (!targetId) return '❌ User tidak ditemukan!';
        await db.createUser(targetId);
        await db.updateUser(targetId, { role: newRole.toLowerCase() });
        await sock.sendMessage(targetId, { text: `🎉 Role kamu: *${newRole.toUpperCase()}*!` }).catch(() => {});
        return `✅ ${formatNumber(targetId)} → *${newRole.toUpperCase()}*!`;
    },

    addvip: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, duration] = args;
        if (!target || !duration) return '❌ Format: !addvip <@user/username> <hari>';
        const targetId = await resolveUser(target);
        const days = parseInt(duration);
        if (!targetId || isNaN(days)) return '❌ Format salah!';
        const expiryDate = new Date(Date.now() + days * 86400000);
        await db.createUser(targetId);
        await db.updateUser(targetId, { vipType: 'fasttrack', vipExpiredAt: expiryDate.toISOString() });
        await sock.sendMessage(targetId, { text: `🎉 *VIP FAST-TRACK!*\n📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}` }).catch(() => {});
        return `⚡ VIP → ${formatNumber(targetId)} ${days} hari!`;
    },

    banned: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const target = args[0];
        if (!target) return '❌ Format: !banned <@user/username>';
        const targetId = await resolveUser(target);
        if (!targetId) return '❌ User tidak ditemukan!';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: true });
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
        return `✅ ${formatNumber(targetId)} *DI-UNBAN!*`;
    },

    addpoint: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [target, points] = args;
        if (!target || !points) return '❌ Format: !addpoint <@user/username> <jumlah>';
        const targetId = await resolveUser(target);
        if (!targetId || isNaN(parseInt(points))) return '❌ Format salah!';
        const user = await db.getUser(targetId) || await db.createUser(targetId);
        const newPoints = (user.points || 0) + parseInt(points);
        await db.updateUser(targetId, { points: newPoints });
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
        return `🤖 *AI STATUS*\n\n🔄 Provider: ${info.current.toUpperCase()}\n\n🔹 Groq: ✅${info.stats.groq.success} ❌${info.stats.groq.failed}\n🔹 Google: ✅${info.stats.google.success} ❌${info.stats.google.failed}`;
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
        await db.bulkUpdateUsers(users => {
            Object.keys(users).forEach(uid => {
                const u = users[uid];
                if (u.aiUsedToday > 0) u.aiUsedToday = 0;
                if (u.vipType === 'real_vip') {
                    u.points = Math.max(0, (u.points || 0) - 50);
                    if (u.points < 50) {
                        u.vipType = 'none';
                        if (sock) sock.sendMessage(uid, { text: '⚠️ *REAL VIP DICABUT*\nPoin tidak cukup (50/hari).' }).catch(() => {});
                    }
                }
                if (u.vipType === 'fasttrack' && u.vipExpiredAt && new Date(u.vipExpiredAt) <= new Date()) {
                    u.vipType = 'none';
                    if (sock) sock.sendMessage(uid, { text: '⚠️ *VIP FAST-TRACK BERAKHIR*' }).catch(() => {});
                }
            });
            return users;
        });
        consoleLog('Daily reset done', 'cron');
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
            console.log('\n📱 SCAN QR CODE:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            consoleLog('Connection closed', 'warning');
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                consoleLog('Logged out! Restart bot.', 'error');
            }
        } else if (connection === 'open') {
            consoleLog('✅ BOT CONNECTED!', 'success');
            isBotReady = true;
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
    console.log('\n🚀 7AI Bot Starting...\n');

    // 🔥 START EXPRESS DULUAN - ANTI HEALTHCHECK FAIL
    const server = app.listen(PORT, '0.0.0.0', () => {
        consoleLog(`✅ Health server ready on port ${PORT}`, 'success');
    });

    // Handle server errors
    server.on('error', (err) => {
        consoleLog(`Server error: ${err.message}`, 'error');
    });

    // Kasih jeda biar server beneran ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    await initializeDatabase();
    setupCronJobs();

    try {
        await connectToWhatsApp();
        isBotReady = true;
    } catch (error) {
        consoleLog(`WhatsApp error: ${error.message}`, 'error');
        // Bot tetap jalan, healthcheck tetap OK
    }

    botStartTime = Date.now();
}

// Start bot
main().catch(err => {
    consoleLog(`Fatal error: ${err.message}`, 'error');
    // Jangan exit, biar healthcheck tetap jalan
});

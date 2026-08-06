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
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== GLOBAL STATE ====================
const authenticatedAdmins = new Map();
const broadcastQueue = [];
let targetGroupId = null;
let sock = null;
let botStartTime = Date.now();

// ==================== YOUR ADMIN NUMBER ====================
const YOUR_NUMBER = '195855541919984@s.whatsapp.net';
const YOUR_NAME = 'Root Admin';

// ==================== LOGGER SETUP ====================
const logger = pino({ level: 'silent' });

const consoleLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
    const emoji = { info: '📘', success: '✅', error: '❌', warning: '⚠️', ai: '🤖', cron: '🕐', broadcast: '📢' };
    console.log(`${emoji[type] || '📘'} [${timestamp}] ${message}`);
};

// ==================== DATABASE INITIALIZATION ====================
async function initializeDatabase() {
    try {
        const dbDir = path.join(__dirname, 'database');
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        await db.init();
        const appConfig = await db.getConfig();
        targetGroupId = appConfig.targetGroupId;
        consoleLog('Database initialized', 'success');
    } catch (error) {
        consoleLog(`Database error: ${error.message}`, 'error');
    }
}

// ==================== HELPER FUNCTIONS ====================
function isAuthenticated(userId) {
    if (userId === YOUR_NUMBER) return true;
    if (!authenticatedAdmins.has(userId)) return false;
    const session = authenticatedAdmins.get(userId);
    if (Date.now() > session.sessionExpiry) {
        authenticatedAdmins.delete(userId);
        return false;
    }
    return true;
}

function isAdmin(userId) {
    if (userId === YOUR_NUMBER) return true;
    if (userId === config.admin.rootNumber) return true;
    return isAuthenticated(userId);
}

async function getUserRole(userId) {
    if (userId === YOUR_NUMBER) return 'root_admin';
    const user = await db.getUser(userId);
    return user ? user.role : 'member';
}

async function getUserData(userId) {
    let user = await db.getUser(userId);
    if (!user) {
        const defaultRole = userId === YOUR_NUMBER ? 'root_admin' : 'member';
        const defaultName = userId === YOUR_NUMBER ? YOUR_NAME : 'Siswa 7A';
        const defaultPoints = userId === YOUR_NUMBER ? 999999 : 0;
        user = await db.createUser(userId, { 
            name: defaultName, 
            role: defaultRole, 
            points: defaultPoints 
        });
    }
    return user;
}

function formatNumber(jid) {
    return jid.split('@')[0];
}

function parseMention(text) {
    const match = text.match(/@(\d+)/);
    return match ? `${match[1]}@s.whatsapp.net` : null;
}

function getCurrentTime() {
    return new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
}

function getCurrentDate() {
    return new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// ==================== COMMAND HANDLERS ====================
const commands = {
    menu: async (userId) => {
        const user = await getUserData(userId);
        const isUserAdmin = isAdmin(userId);
        
        let text = `🤖 *7A INTELLIGENCE (7AI) v2.0.0*\n`;
        text += `📅 ${getCurrentDate()} | 🕐 ${getCurrentTime()} WIB\n\n`;
        text += `👤 *${user.name}*\n`;
        text += `⭐ Role: ${user.role.toUpperCase()}\n`;
        text += `💰 Poin: ${user.points}\n`;
        text += `━━━━━━━━━━━━━━━━━━\n\n`;
        text += `📋 *MENU UTAMA*\n\n`;
        text += `🤖 !ai <pertanyaan> - Tanya AI\n`;
        text += `👤 !profile - Lihat profil (Japri)\n`;
        text += `💰 !poin - Cek poin (Japri)\n`;
        text += `🎮 !kuis - Main kuis (+10 Poin)\n`;
        text += `📊 !leaderboard - Top 10 poin\n`;
        text += `💎 !claimvip - Klaim Real VIP (Japri)\n`;
        text += `⚡ !buyvip - Info VIP Fast-Track (Japri)\n`;
        
        if (isUserAdmin) {
            text += `\n👑 *ADMIN COMMANDS*\n`;
            text += `🔐 !login <user> <pass> - Login Admin\n`;
            text += `📢 !broadcast <pesan> - Kirim pengumuman\n`;
            text += `⚙️ !setgroup - Set grup utama (di grup)\n`;
            text += `👥 !setrole @user <role> - Ubah role\n`;
            text += `💎 !addvip @user <hari> - Tambah VIP\n`;
            text += `🚫 !banned @user - Ban user\n`;
            text += `✅ !unban @user - Unban user\n`;
            text += `💰 !addpoint @user <jumlah> - Tambah poin\n`;
            text += `🔄 !resetlimit - Reset limit AI\n`;
            text += `🤖 !aistatus - Cek status AI\n`;
            text += `✅ !acc <id> - Setujui broadcast\n`;
            text += `❌ !reject <id> - Tolak broadcast\n`;
        }
        
        text += `\n🕐 Reset limit & VIP: 00:00 WIB`;
        return text;
    },

    profile: async (userId, chatType) => {
        if (chatType !== 'private') {
            return '⚠️ Demi keamanan, privasi, dan kenyamanan grup, perintah ini WAJIB digunakan via Chat Pribadi (Japri) langsung ke Bot 7AI!';
        }

        const user = await getUserData(userId);
        let limit = config.aiLimits[user.role] || 5;
        if (user.vipType === 'fasttrack') limit = config.vip.fastTrack.dailyLimit;
        else if (user.vipType === 'real_vip') limit = Math.max(Math.floor(config.vip.realVip.limitPercentage * user.points), config.aiLimits.real_vip);
        if (user.role === 'root_admin' || user.role === 'admin' || user.role === 'operational_admin') limit = '∞';

        let text = `👤 *PROFIL 7AI*\n\n`;
        text += `📱 Nomor: ${formatNumber(userId)}\n`;
        text += `📝 Nama: ${user.name}\n`;
        text += `⭐ Role: ${user.role.toUpperCase()}\n`;
        text += `💎 VIP: ${user.vipType === 'none' ? '❌ Tidak Aktif' : `✅ ${user.vipType}`}\n`;
        if (user.vipType === 'fasttrack' && user.vipExpiredAt) {
            text += `📅 Expired: ${new Date(user.vipExpiredAt).toLocaleDateString('id-ID')}\n`;
        }
        text += `💰 Poin: ${user.points}\n`;
        text += `🤖 AI Used: ${user.aiUsedToday}/${limit}\n`;
        text += `🚫 Status: ${user.isBanned ? '🔴 Dibanned' : '🟢 Aktif'}`;
        return text;
    },

    poin: async (userId, chatType) => {
        if (chatType !== 'private') {
            return '⚠️ Demi keamanan, privasi, dan kenyamanan grup, perintah ini WAJIB digunakan via Chat Pribadi (Japri) langsung ke Bot 7AI!';
        }
        const user = await getUserData(userId);
        return `💰 *SALDO POIN*\n\n👤 ${user.name}\n💎 Poin: ${user.points}\n⭐ Role: ${user.role.toUpperCase()}\n\n💡 Main !kuis untuk dapat poin!\n🎯 100 Poin = Real VIP`;
    },

    leaderboard: async () => {
        const users = await db.getAllUsers();
        const sorted = Object.entries(users)
            .sort(([, a], [, b]) => (b.points || 0) - (a.points || 0))
            .slice(0, 10);

        if (sorted.length === 0) return '📊 *LEADERBOARD*\n\nBelum ada data poin.';

        let text = `📊 *TOP 10 POIN TERTINGGI*\n━━━━━━━━━━━━━━━━━━\n\n`;
        sorted.forEach(([userId, user], index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            text += `${medal} *${user.name}*\n   💰 ${user.points} poin | ⭐ ${user.role}\n\n`;
        });
        return text;
    },

    login: async (userId, chatType, args) => {
        if (chatType !== 'private') {
            return '⚠️ Demi keamanan, privasi, dan kenyamanan grup, perintah ini WAJIB digunakan via Chat Pribadi (Japri) langsung ke Bot 7AI!';
        }

        if (userId === YOUR_NUMBER) {
            return '✅ Anda adalah Root Admin permanen! Tidak perlu login.\n\nGunakan langsung command admin.';
        }

        const [username, password] = args;
        if (!username || !password) return '❌ Format: !login <username> <password>';

        if (password !== config.admin.password) return '❌ Password salah!';

        const sessionData = {
            username,
            timestamp: Date.now(),
            sessionExpiry: Date.now() + (3600000 * 24)
        };
        authenticatedAdmins.set(userId, sessionData);
        
        await db.createUser(userId, { name: username, role: 'operational_admin' });
        consoleLog(`Admin login: ${formatNumber(userId)}`, 'success');

        return `✅ *LOGIN BERHASIL!*\n\n👤 Username: ${username}\n⭐ Role: Operational Admin\n⏰ Expired: ${new Date(sessionData.sessionExpiry).toLocaleString('id-ID')}\n\nGunakan !menu untuk lihat command admin.`;
    },

    ai: async (userId, chatType, args) => {
        const prompt = args.join(' ');
        if (!prompt) return '❌ Format: !ai <pertanyaan>\n\nContoh: !ai jelaskan tentang fotosintesis';

        const user = await getUserData(userId);
        if (user.isBanned) return '🚫 Akun Anda dibanned.';

        let limit = config.aiLimits[user.role] || 5;
        if (user.vipType === 'fasttrack') limit = config.vip.fastTrack.dailyLimit;
        else if (user.vipType === 'real_vip') limit = Math.max(Math.floor(config.vip.realVip.limitPercentage * user.points), config.aiLimits.real_vip);
        if (user.role === 'root_admin' || user.role === 'admin' || user.role === 'operational_admin') limit = Infinity;

        if (user.aiUsedToday >= limit && limit !== Infinity) {
            return `⚠️ *LIMIT AI HARIAN HABIS!*\n\n📊 ${user.aiUsedToday}/${limit}\n🕐 Reset: 00:00 WIB\n\n💡 Upgrade ke VIP: !buyvip`;
        }

        try {
            const response = await aiService.generateResponse(prompt, `Kelas 7A SMP`);
            const newUsage = (user.aiUsedToday || 0) + 1;
            await db.updateUser(userId, { aiUsedToday: newUsage });
            const provider = aiService.getProviderInfo().current.toUpperCase();
            
            return `🤖 *7AI RESPONSE* (via ${provider})\n\n${response}\n\n━━━━━━━━━━━━━━━━━━\n📊 AI Usage: ${newUsage}/${limit === Infinity ? '∞' : limit}`;
        } catch (error) {
            return `❌ *AI ERROR*\n\n${error.message}\n\nCoba lagi nanti.`;
        }
    },

    aistatus: async (userId) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        
        const info = aiService.getProviderInfo();
        return `🤖 *AI STATUS*\n\n🔄 Provider: ${info.current.toUpperCase()}\n📊 Groq: ✅${info.stats.groq.success} ❌${info.stats.groq.failed}\n📊 Google: ✅${info.stats.google.success} ❌${info.stats.google.failed}`;
    },

    setgroup: async (userId, chatType, args, context) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';

        if (chatType !== 'group') {
            return '⚠️ Perintah ini hanya bisa digunakan di dalam grup!\n\n1. Masuk ke grup\n2. Ketik !setgroup';
        }

        if (context && context.groupId) {
            targetGroupId = context.groupId;
            await db.updateConfig({ targetGroupId: context.groupId });
            consoleLog(`Target group set: ${context.groupId}`, 'success');
            
            try {
                const groupMeta = await sock.groupMetadata(context.groupId);
                return `✅ *GRUP UTAMA BERHASIL DIATUR!*\n\n👥 Nama: ${groupMeta.subject}\n👤 Member: ${groupMeta.participants.length}\n\nSemua broadcast akan dikirim ke sini.`;
            } catch {
                return `✅ Grup utama berhasil diatur!\nID: ${context.groupId}`;
            }
        }
        return '❌ Gagal. Pastikan di dalam grup.';
    },

    broadcast: async (userId, chatType, args) => {
        if (chatType !== 'private') {
            return '⚠️ Demi keamanan, privasi, dan kenyamanan grup, perintah ini WAJIB digunakan via Chat Pribadi (Japri) langsung ke Bot 7AI!';
        }

        if (!targetGroupId) return '❌ Grup target belum diatur! Gunakan !setgroup di grup.';

        const message = args.join(' ');
        if (!message) return '❌ Format: !broadcast <pesan>';

        if (isAdmin(userId)) {
            try {
                await sock.sendMessage(targetGroupId, { 
                    text: `📢 *PENGUMUMAN ADMIN*\n━━━━━━━━━━━━━━━━━━\n\n${message}\n\n━━━━━━━━━━━━━━━━━━\n👤 Admin 7AI\n🕐 ${getCurrentTime()} WIB`
                });
                consoleLog('Admin broadcast sent', 'broadcast');
                return '✅ Pengumuman berhasil dikirim!';
            } catch (error) {
                return '❌ Gagal mengirim. Bot masih di grup?';
            }
        }

        const broadcastId = `BRC${Date.now().toString(36).toUpperCase()}`;
        broadcastQueue.push({ id: broadcastId, userId, message, timestamp: Date.now() });

        await sock.sendMessage(YOUR_NUMBER, { 
            text: `📩 *PENGAJUAN BROADCAST*\n🆔 ${broadcastId}\n👤 ${formatNumber(userId)}\n💬 "${message}"\n\n!acc ${broadcastId} | !reject ${broadcastId}`
        });

        return `⏳ Pengajuan dikirim ke Admin.\n🆔 ID: ${broadcastId}`;
    },

    acc: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const broadcastId = args[0];
        if (!broadcastId) return '❌ Format: !acc <id>';

        const index = broadcastQueue.findIndex(item => item.id === broadcastId);
        if (index === -1) return '❌ Tidak ditemukan!';

        const broadcast = broadcastQueue[index];
        broadcastQueue.splice(index, 1);

        await sock.sendMessage(targetGroupId, { 
            text: `📢 *PENGUMUMAN*\n━━━━━━━━━━━━━━━━━━\n\n${broadcast.message}\n\n━━━━━━━━━━━━━━━━━━\n✅ Disetujui Admin`
        });

        await sock.sendMessage(broadcast.userId, { text: `✅ Pengajuan ${broadcastId} DISETUJUI!` });
        return `✅ Broadcast ${broadcastId} dikirim!`;
    },

    reject: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const broadcastId = args[0];
        if (!broadcastId) return '❌ Format: !reject <id>';

        const index = broadcastQueue.findIndex(item => item.id === broadcastId);
        if (index === -1) return '❌ Tidak ditemukan!';

        const broadcast = broadcastQueue[index];
        broadcastQueue.splice(index, 1);

        await sock.sendMessage(broadcast.userId, { text: `❌ Pengajuan ${broadcastId} DITOLAK.` });
        return `❌ Broadcast ${broadcastId} ditolak.`;
    },

    claimvip: async (userId, chatType) => {
        if (chatType !== 'private') {
            return '⚠️ Demi keamanan, privasi, dan kenyamanan grup, perintah ini WAJIB digunakan via Chat Pribadi (Japri) langsung ke Bot 7AI!';
        }
        const user = await getUserData(userId);
        if (user.vipType !== 'none') return '❌ Anda sudah VIP!';
        if (user.points < config.vip.realVip.activationCost) {
            return `❌ Poin kurang!\n💎 Butuh: ${config.vip.realVip.activationCost}\n💰 Poin Anda: ${user.points}`;
        }
        const newPoints = user.points - config.vip.realVip.activationCost;
        await db.updateUser(userId, { points: newPoints, vipType: 'real_vip', vipExpiredAt: null });
        return `🎉 *REAL VIP AKTIF!*\n\n💰 Poin: ${newPoints}\n⚠️ Biaya: 50 poin/hari`;
    },

    buyvip: async (userId, chatType) => {
        if (chatType !== 'private') {
            return '⚠️ Demi keamanan, privasi, dan kenyamanan grup, perintah ini WAJIB digunakan via Chat Pribadi (Japri) langsung ke Bot 7AI!';
        }
        return `⚡ *VIP FAST-TRACK*\n\n💵 Rp2.000 / 2 Hari\n🤖 Limit: 25x/hari\n\n📞 Hubungi Admin: wa.me/${formatNumber(YOUR_NUMBER)}`;
    },

    kuis: async (userId) => {
        const questions = [
            { q: 'Apa ibu kota Indonesia?', a: 'jakarta' },
            { q: 'Berapa 12 × 5?', a: '60' },
            { q: 'Siapa presiden pertama Indonesia?', a: 'soekarno' },
            { q: 'Apa lambang kimia air?', a: 'h2o' },
            { q: 'Berapa sisi segitiga?', a: '3' }
        ];
        const random = questions[Math.floor(Math.random() * questions.length)];
        const user = await getUserData(userId);
        await db.updateUser(userId, { lastQuestion: random.q, lastAnswer: random.a.toLowerCase(), quizActive: true });
        return `🎮 *KUIS 7AI* (+10 Poin)\n\n❓ ${random.q}\n\n📝 Jawab langsung!\n💰 Poin: ${user.points}`;
    },

    setrole: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [targetMention, newRole] = args;
        if (!targetMention || !newRole) return '❌ Format: !setrole @user <officer/member/admin>';
        const targetId = parseMention(targetMention);
        if (!targetId) return '❌ Format mention salah!';
        if (!['officer', 'member', 'admin', 'operational_admin'].includes(newRole.toLowerCase())) {
            return '❌ Role tidak valid! Pilih: officer, member, admin';
        }
        await db.createUser(targetId);
        await db.updateUser(targetId, { role: newRole.toLowerCase() });
        return `✅ Role @${formatNumber(targetId)} diubah ke *${newRole.toUpperCase()}*!`;
    },

    addvip: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [targetMention, duration] = args;
        if (!targetMention || !duration) return '❌ Format: !addvip @user <hari>';
        const targetId = parseMention(targetMention);
        if (!targetId) return '❌ Format mention salah!';
        const days = parseInt(duration);
        if (isNaN(days) || days < 1) return '❌ Durasi harus angka!';
        const expiryDate = new Date(Date.now() + days * 86400000);
        await db.createUser(targetId);
        await db.updateUser(targetId, { vipType: 'fasttrack', vipExpiredAt: expiryDate.toISOString() });
        return `⚡ VIP Fast-Track untuk @${formatNumber(targetId)} selama *${days} hari*!\n📅 Expired: ${expiryDate.toLocaleDateString('id-ID')}`;
    },

    banned: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const targetMention = args[0];
        if (!targetMention) return '❌ Format: !banned @user';
        const targetId = parseMention(targetMention);
        if (!targetId) return '❌ Format mention salah!';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: true });
        return `🚫 @${formatNumber(targetId)} dibanned!`;
    },

    unban: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const targetMention = args[0];
        if (!targetMention) return '❌ Format: !unban @user';
        const targetId = parseMention(targetMention);
        if (!targetId) return '❌ Format mention salah!';
        await db.createUser(targetId);
        await db.updateUser(targetId, { isBanned: false });
        return `✅ @${formatNumber(targetId)} di-unban!`;
    },

    addpoint: async (userId, chatType, args) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        const [targetMention, points] = args;
        if (!targetMention || !points) return '❌ Format: !addpoint @user <jumlah>';
        const targetId = parseMention(targetMention);
        if (!targetId) return '❌ Format mention salah!';
        const pointAmount = parseInt(points);
        if (isNaN(pointAmount)) return '❌ Jumlah harus angka!';
        await db.createUser(targetId);
        const user = await db.getUser(targetId);
        const newPoints = (user.points || 0) + pointAmount;
        await db.updateUser(targetId, { points: newPoints });
        return `✅ ${pointAmount} poin ke @${formatNumber(targetId)}!\n💰 Total: ${newPoints}`;
    },

    resetlimit: async (userId) => {
        if (!isAdmin(userId)) return '❌ Hanya Admin!';
        let count = 0;
        await db.bulkUpdateUsers(users => {
            Object.keys(users).forEach(key => {
                if (users[key].aiUsedToday > 0) { users[key].aiUsedToday = 0; count++; }
            });
            return users;
        });
        return `✅ Limit ${count} user direset!`;
    }
};

// ==================== MESSAGE HANDLER ====================
async function handleMessage(message) {
    try {
        const { key, message: msg } = message;
        const userId = key.remoteJid;
        if (key.fromMe) return;
        
        const chatType = userId.endsWith('@g.us') ? 'group' : 'private';
        const text = msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || '';
        
        if (!text || !text.startsWith('!')) return;

        const [command, ...args] = text.slice(1).split(' ');
        const handler = commands[command.toLowerCase()];

        if (handler) {
            const response = await handler(userId, chatType, args, {
                groupId: chatType === 'group' ? userId : null
            });
            if (response) {
                await sock.sendMessage(userId, { text: response }, { quoted: message });
            }
        } else {
            const user = await db.getUser(userId);
            if (user && user.quizActive && user.lastQuestion) {
                const answer = text.slice(1).toLowerCase().trim();
                const correctAnswer = user.lastAnswer.toLowerCase().trim();
                const isCorrect = answer === correctAnswer || correctAnswer.includes(answer) || answer.includes(correctAnswer);
                
                if (isCorrect) {
                    const newPoints = (user.points || 0) + 10;
                    await db.updateUser(userId, { points: newPoints, lastQuestion: null, lastAnswer: null, quizActive: false });
                    await sock.sendMessage(userId, { text: `🎉 *BENAR!* +10 Poin\n💰 Total: ${newPoints}\n\nKetik !kuis lagi!` }, { quoted: message });
                } else {
                    await db.updateUser(userId, { lastQuestion: null, lastAnswer: null, quizActive: false });
                    await sock.sendMessage(userId, { text: `❌ *SALAH!*\nJawaban: ${user.lastAnswer}\n\n!kuis untuk coba lagi.` }, { quoted: message });
                }
            }
        }
    } catch (error) {
        consoleLog(`Handler error: ${error.message}`, 'error');
    }
}

// ==================== CRON JOBS ====================
function setupCronJobs() {
    cron.schedule('0 17 * * *', async () => {
        consoleLog('Daily reset (00:00 WIB)...', 'cron');
        try {
            await db.bulkUpdateUsers(users => {
                Object.keys(users).forEach(userId => {
                    const user = users[userId];
                    user.aiUsedToday = 0;
                    if (user.vipType === 'real_vip') {
                        user.points = Math.max(0, (user.points || 0) - 50);
                        if (user.points < 50) {
                            user.vipType = 'none';
                            user.vipExpiredAt = null;
                        }
                    }
                    if (user.vipType === 'fasttrack' && user.vipExpiredAt && new Date(user.vipExpiredAt) <= new Date()) {
                        user.vipType = 'none';
                        user.vipExpiredAt = null;
                    }
                });
                return users;
            });
            consoleLog('Daily reset completed', 'cron');
        } catch (error) {
            consoleLog(`Reset error: ${error.message}`, 'error');
        }
    }, { timezone: 'Asia/Jakarta' });
}

// ==================== KEEP-ALIVE SERVER ====================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        bot: '7A Intelligence (7AI)',
        version: '2.0.0',
        uptime: Math.floor((Date.now() - botStartTime) / 1000),
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ==================== WHATSAPP CONNECTION ====================
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ['7AI Bot', 'Chrome', '1.0.0'],
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('\n📱 Scan QR Code berikut:\n');
                qrcode.generate(qr, { small: true });
            }
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                consoleLog(`Connection closed (${statusCode})`, 'warning');
                if (shouldReconnect) {
                    consoleLog('Reconnecting in 5s...', 'info');
                    setTimeout(() => connectToWhatsApp(), 5000);
                } else {
                    consoleLog('Logged out! Restart bot.', 'error');
                }
            } else if (connection === 'open') {
                consoleLog('✅ Bot connected!', 'success');
                consoleLog(`🤖 ${config.botName} ready!`, 'success');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type === 'notify') {
                for (const message of messages) {
                    await handleMessage(message);
                }
            }
        });

        return sock;
    } catch (error) {
        consoleLog(`Connection error: ${error.message}`, 'error');
        throw error;
    }
}

// ==================== MAIN ====================
async function main() {
    console.log('\n==================================================');
    console.log('🚀 7A Intelligence Bot Starting...');
    console.log('==================================================\n');
    
    await initializeDatabase();
    setupCronJobs();
    
    // Start keep-alive server
    app.listen(PORT, '0.0.0.0', () => {
        consoleLog(`🌐 Health server: http://0.0.0.0:${PORT}`, 'success');
    });
    
    // Handle shutdown
    process.on('SIGINT', async () => {
        consoleLog('Shutting down...', 'warning');
        process.exit(0);
    });
    
    await connectToWhatsApp();
    botStartTime = Date.now();
}

main().catch(console.error);

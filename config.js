import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
    botName: process.env.BOT_NAME || '7A Intelligence (7AI)',
    version: '2.0.0',
    groq: {
        apiKeys: [
            process.env.GROQ_API_KEY_1,
            process.env.GROQ_API_KEY_2
        ].filter(Boolean),
        model: 'mixtral-8x7b-32768',
        maxTokens: 1024,
        temperature: 0.7
    },
    googleAI: {
        apiKeys: [
            process.env.GOOGLE_AI_API_KEY_1,
            process.env.GOOGLE_AI_API_KEY_2
        ].filter(k => k && k !== 'your_google_key_2_here'),
        model: 'gemini-pro',
        maxTokens: 1024,
        temperature: 0.7
    },
    aiProvider: process.env.AI_PROVIDER_PRIORITY || 'auto',
    admin: {
        rootNumber: process.env.ADMIN_NUMBER || '6282342067571@s.whatsapp.net',
        password: process.env.ADMIN_PASSWORD || 'Ilham2013'
    },
    database: {
        usersPath: process.env.DATABASE_PATH || join(__dirname, 'database', 'users.json'),
        configPath: process.env.CONFIG_PATH || join(__dirname, 'database', 'config.json')
    },
    aiLimits: {
        'root_admin': Infinity,
        'admin': Infinity,
        'operational_admin': Infinity,
        'officer': 40,
        'vip_fasttrack': 25,
        'real_vip': 50,
        'member': 5
    },
    vip: {
        fastTrack: { cost: 'Rp2.000', duration: 2, dailyLimit: 25 },
        realVip: { activationCost: 100, dailyDeduction: 50, limitPercentage: 0.5 }
    },
    timezone: 'Asia/Jakarta',
    gamePoints: 5
}

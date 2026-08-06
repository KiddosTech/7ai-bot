import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
    // Bot Identity
    botName: process.env.BOT_NAME || '7A Intelligence (7AI)',
    version: '2.0.0',
    
    // Groq Configuration
    groq: {
        apiKeys: [
            process.env.GROQ_API_KEY_1,
            process.env.GROQ_API_KEY_2
        ].filter(Boolean),
        model: 'mixtral-8x7b-32768',
        maxTokens: 1024,
        temperature: 0.7
    },
    
    // Google AI Studio Configuration
    googleAI: {
        apiKeys: [
            process.env.GOOGLE_AI_API_KEY_1,
            process.env.GOOGLE_AI_API_KEY_2
        ].filter(Boolean),
        model: 'gemini-pro',
        maxTokens: 1024,
        temperature: 0.7
    },
    
    // AI Provider Settings
    aiProvider: process.env.AI_PROVIDER_PRIORITY || 'auto', // 'groq', 'google', 'auto'
    
    // Admin Settings
    admin: {
        rootNumber: process.env.ADMIN_NUMBER || '628xxx@s.whatsapp.net',
        password: process.env.ADMIN_PASSWORD || 'Ilham2013'
    },
    
    // Database Paths
    database: {
        usersPath: process.env.DATABASE_PATH || join(__dirname, 'database', 'users.json'),
        configPath: process.env.CONFIG_PATH || join(__dirname, 'database', 'config.json')
    },
    
    // AI Daily Limits by Role
    aiLimits: {
        'root_admin': Infinity,
        'supervisor_admin': Infinity,
        'operational_admin': Infinity,
        'officer': 40,
        'vip_fasttrack': 25,
        'real_vip': 50,
        'member': 5
    },
    
    // VIP Settings
    vip: {
        fastTrack: {
            cost: 'Rp2.000',
            duration: 2,
            dailyLimit: 25
        },
        realVip: {
            activationCost: 100,
            dailyDeduction: 50,
            limitPercentage: 0.5
        }
    },
    
    // Timezone
    timezone: 'Asia/Jakarta'
};
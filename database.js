import fs from 'fs/promises';
import { config } from './config.js';

class Database {
    constructor() {
        this.usersPath = config.database.usersPath;
        this.configPath = config.database.configPath;
    }

    async init() {
        try {
            await fs.mkdir('./database', { recursive: true });
            await this.read(this.usersPath, {});
            await this.read(this.configPath, { targetGroupId: null });
        } catch (error) {
            console.error('Database error:', error);
        }
    }

    async read(filePath, defaultValue) {
        try {
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2));
                return defaultValue;
            }
            throw error;
        }
    }

    async write(filePath, data) {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    }

    async getUser(userId) {
        const users = await this.read(this.usersPath, {});
        return users[userId] || null;
    }

    async getUserByUsername(username) {
        const users = await this.read(this.usersPath, {});
        for (const [id, user] of Object.entries(users)) {
            if (user.username && user.username.toLowerCase() === username.toLowerCase()) {
                return { id, ...user };
            }
        }
        return null;
    }

    async createUser(userId, data = {}) {
        const users = await this.read(this.usersPath, {});
        if (!users[userId]) {
            users[userId] = {
                username: data.username || null,
                name: data.name || 'Siswa 7A',
                role: data.role || 'member',
                vipType: data.vipType || 'none',
                vipExpiredAt: data.vipExpiredAt || null,
                points: data.points || 0,
                aiUsedToday: data.aiUsedToday || 0,
                isBanned: data.isBanned || false,
                lastQuestion: null,
                lastAnswer: null,
                quizActive: false,
                registeredAt: new Date().toISOString()
            };
            await this.write(this.usersPath, users);
        }
        return users[userId];
    }

    async updateUser(userId, updates) {
        const users = await this.read(this.usersPath, {});
        if (users[userId]) {
            users[userId] = { ...users[userId], ...updates };
            await this.write(this.usersPath, users);
        }
        return users[userId] || null;
    }

    async getAllUsers() {
        return await this.read(this.usersPath, {});
    }

    async getConfig() {
        return await this.read(this.configPath, { targetGroupId: null });
    }

    async updateConfig(updates) {
        const current = await this.read(this.configPath, {});
        const newConfig = { ...current, ...updates };
        await this.write(this.configPath, newConfig);
        return newConfig;
    }

    async bulkUpdateUsers(updateFn) {
        const users = await this.read(this.usersPath, {});
        const updated = updateFn(users);
        await this.write(this.usersPath, updated);
        return updated;
    }
}

export const db = new Database();

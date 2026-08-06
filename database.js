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
            await this.read(this.configPath, {
                targetGroupId: null,
                broadcastQueue: []
            });
        } catch (error) {
            console.error('Database initialization error:', error);
        }
    }

    async read(filePath, defaultValue = {}) {
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

    // User Operations
    async getUser(userId) {
        const users = await this.read(this.usersPath);
        return users[userId] || null;
    }

    async createUser(userId, data = {}) {
        const users = await this.read(this.usersPath);
        if (!users[userId]) {
            users[userId] = {
                name: data.name || 'Siswa 7A',
                role: 'member',
                vipType: 'none',
                vipExpiredAt: null,
                points: 0,
                customAiLimit: 0,
                aiUsedToday: 0,
                isBanned: false,
                ...data
            };
            await this.write(this.usersPath, users);
        }
        return users[userId];
    }

    async updateUser(userId, updates) {
        const users = await this.read(this.usersPath);
        if (users[userId]) {
            users[userId] = { ...users[userId], ...updates };
            await this.write(this.usersPath, users);
            return users[userId];
        }
        return null;
    }

    async getAllUsers() {
        return await this.read(this.usersPath);
    }

    // Config Operations
    async getConfig() {
        return await this.read(this.configPath);
    }

    async updateConfig(updates) {
        const config = await this.read(this.configPath);
        const newConfig = { ...config, ...updates };
        await this.write(this.configPath, newConfig);
        return newConfig;
    }

    // User Existence Check
    async userExists(userId) {
        const users = await this.read(this.usersPath);
        return !!users[userId];
    }

    // Bulk User Operations
    async bulkUpdateUsers(updateFn) {
        const users = await this.read(this.usersPath);
        const updatedUsers = updateFn(users);
        await this.write(this.usersPath, updatedUsers);
        return updatedUsers;
    }
}

export const db = new Database();
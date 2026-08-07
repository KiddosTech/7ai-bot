import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

class AIServiceManager {
    constructor() {
        // Groq
        this.groqKeys = config.groq.apiKeys;
        this.groqClients = this.groqKeys.map(key => new Groq({ apiKey: key }));
        this.currentGroqIndex = 0;

        // Google AI
        this.googleKeys = config.googleAI.apiKeys.filter(k => k && k !== 'your_google_key_2_here');
        this.googleClients = this.googleKeys.map(key => {
            const genAI = new GoogleGenerativeAI(key);
            return genAI.getGenerativeModel({ model: config.googleAI.model });
        });
        this.currentGoogleIndex = 0;

        // Provider
        this.providerPriority = config.aiProvider;
        this.currentProvider = this.determineInitialProvider();
        this.providerStats = {
            groq: { success: 0, failed: 0 },
            google: { success: 0, failed: 0 }
        };

        console.log('🤖 AI Service Manager:');
        console.log(`   - Groq Keys: ${this.groqKeys.length}`);
        console.log(`   - Google Keys: ${this.googleKeys.length}`);
        console.log(`   - Priority: ${this.providerPriority}`);
        console.log(`   - Provider: ${this.currentProvider.toUpperCase()}`);
    }

    determineInitialProvider() {
        if (this.providerPriority === 'groq' && this.groqKeys.length > 0) return 'groq';
        if (this.providerPriority === 'google' && this.googleKeys.length > 0) return 'google';
        if (this.providerPriority === 'auto') {
            if (this.groqKeys.length > 0) return 'groq';
            if (this.googleKeys.length > 0) return 'google';
        }
        if (this.groqKeys.length > 0) return 'groq';
        if (this.googleKeys.length > 0) return 'google';
        throw new Error('No AI API keys configured!');
    }

    switchProvider() {
        if (this.currentProvider === 'groq' && this.googleKeys.length > 0) {
            this.currentProvider = 'google';
        } else if (this.currentProvider === 'google' && this.groqKeys.length > 0) {
            this.currentProvider = 'groq';
        }
    }

    rotateGroqKey() {
        this.currentGroqIndex = (this.currentGroqIndex + 1) % this.groqKeys.length;
    }

    rotateGoogleKey() {
        this.currentGoogleIndex = (this.currentGoogleIndex + 1) % this.googleKeys.length;
    }

    async generateWithGroq(prompt) {
        const systemPrompt = 'Kamu adalah 7A Intelligence (7AI), asisten AI untuk kelas 7A SMP. Ramah, edukatif, bahasa Indonesia santai.';
        const client = this.groqClients[this.currentGroqIndex];
        const completion = await client.chat.completions.create({
            model: config.groq.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ],
            max_tokens: config.groq.maxTokens,
            temperature: config.groq.temperature
        });
        return completion.choices[0].message.content;
    }

    async generateWithGoogle(prompt) {
        const systemPrompt = 'Kamu adalah 7A Intelligence (7AI), asisten AI untuk kelas 7A SMP. Ramah, edukatif, bahasa Indonesia santai.';
        const model = this.googleClients[this.currentGoogleIndex];
        const result = await model.generateContent(`${systemPrompt}\n\nPertanyaan: ${prompt}`);
        const response = await result.response;
        return response.text();
    }

    async generateResponse(prompt) {
        let lastError = null;
        const maxAttempts = this.groqKeys.length + this.googleKeys.length;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                let text;
                if (this.currentProvider === 'groq' && this.groqKeys.length > 0) {
                    text = await this.generateWithGroq(prompt);
                    this.providerStats.groq.success++;
                    return { text, provider: 'groq' };
                } else if (this.currentProvider === 'google' && this.googleKeys.length > 0) {
                    text = await this.generateWithGoogle(prompt);
                    this.providerStats.google.success++;
                    return { text, provider: 'google' };
                }
            } catch (error) {
                lastError = error;
                if (this.currentProvider === 'groq') {
                    this.providerStats.groq.failed++;
                    if (error.status === 429) this.rotateGroqKey();
                } else {
                    this.providerStats.google.failed++;
                    if (error.status === 429) this.rotateGoogleKey();
                }
                this.switchProvider();
            }
        }

        throw new Error(`Semua AI provider gagal. Error: ${lastError.message}`);
    }

    getProviderInfo() {
        return {
            current: this.currentProvider,
            priority: this.providerPriority,
            stats: this.providerStats,
            groqKeys: this.groqKeys.length,
            googleKeys: this.googleKeys.length
        };
    }
}

export const aiService = new AIServiceManager();

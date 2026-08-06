import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

class AIServiceManager {
    constructor() {
        // Initialize Groq clients
        this.groqKeys = config.groq.apiKeys;
        this.groqClients = this.groqKeys.map(key => new Groq({ apiKey: key }));
        this.currentGroqIndex = 0;
        
        // Initialize Google AI clients
        this.googleKeys = config.googleAI.apiKeys;
        this.googleClients = this.googleKeys.map(key => {
            const genAI = new GoogleGenerativeAI(key);
            return genAI.getGenerativeModel({ model: config.googleAI.model });
        });
        this.currentGoogleIndex = 0;
        
        // Provider management
        this.providerPriority = config.aiProvider;
        this.currentProvider = this.determineInitialProvider();
        this.providerStats = {
            groq: { success: 0, failed: 0, lastUsed: null },
            google: { success: 0, failed: 0, lastUsed: null }
        };
        
        console.log('🤖 AI Service Manager initialized:');
        console.log(`   - Groq API Keys: ${this.groqKeys.length}`);
        console.log(`   - Google AI Keys: ${this.googleKeys.length}`);
        console.log(`   - Priority: ${this.providerPriority}`);
        console.log(`   - Starting Provider: ${this.currentProvider}`);
    }

    determineInitialProvider() {
        if (this.providerPriority === 'groq' && this.groqKeys.length > 0) {
            return 'groq';
        } else if (this.providerPriority === 'google' && this.googleKeys.length > 0) {
            return 'google';
        } else if (this.providerPriority === 'auto') {
            // Auto-select based on available keys
            if (this.groqKeys.length > 0) return 'groq';
            if (this.googleKeys.length > 0) return 'google';
        }
        
        // Fallback
        if (this.groqKeys.length > 0) return 'groq';
        if (this.googleKeys.length > 0) return 'google';
        
        throw new Error('No AI API keys configured!');
    }

    async switchProvider() {
        const previousProvider = this.currentProvider;
        
        if (this.currentProvider === 'groq' && this.googleKeys.length > 0) {
            this.currentProvider = 'google';
        } else if (this.currentProvider === 'google' && this.groqKeys.length > 0) {
            this.currentProvider = 'groq';
        } else {
            // If only one provider available, rotate keys within same provider
            if (this.currentProvider === 'groq') {
                this.rotateGroqKey();
            } else {
                this.rotateGoogleKey();
            }
            return;
        }
        
        console.log(`🔄 Switched AI Provider: ${previousProvider} → ${this.currentProvider}`);
    }

    rotateGroqKey() {
        this.currentGroqIndex = (this.currentGroqIndex + 1) % this.groqKeys.length;
        console.log(`🔄 Rotated Groq API Key to #${this.currentGroqIndex + 1}`);
    }

    rotateGoogleKey() {
        this.currentGoogleIndex = (this.currentGoogleIndex + 1) % this.googleKeys.length;
        console.log(`🔄 Rotated Google AI Key to #${this.currentGoogleIndex + 1}`);
    }

    async generateWithGroq(prompt, context) {
        const systemPrompt = `Kamu adalah 7A Intelligence (7AI), asisten AI untuk kelas 7A SMP. 
        Kamu ramah, edukatif, dan membantu siswa belajar. 
        Gunakan bahasa Indonesia yang santai, jelas, dan mudah dipahami.
        Berikan jawaban yang akurat tapi tetap menyenangkan.
        Konteks: ${context}`;

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

        return {
            text: completion.choices[0].message.content,
            provider: 'groq',
            model: config.groq.model
        };
    }

    async generateWithGoogle(prompt, context) {
        const systemPrompt = `Kamu adalah 7A Intelligence (7AI), asisten AI untuk kelas 7A SMP.
        ${context}
        
        Jawablah pertanyaan berikut dengan ramah dan edukatif dalam bahasa Indonesia:`;
        
        const fullPrompt = `${systemPrompt}\n\nPertanyaan: ${prompt}`;
        
        const model = this.googleClients[this.currentGoogleIndex];
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        
        return {
            text: response.text(),
            provider: 'google',
            model: config.googleAI.model
        };
    }

    async generateResponse(prompt, context = '') {
        let lastError = null;
        const maxAttempts = 4; // Try each provider twice max

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                let result;
                
                // Try current provider
                if (this.currentProvider === 'groq') {
                    result = await this.generateWithGroq(prompt, context);
                    this.providerStats.groq.success++;
                    this.providerStats.groq.lastUsed = new Date();
                } else {
                    result = await this.generateWithGoogle(prompt, context);
                    this.providerStats.google.success++;
                    this.providerStats.google.lastUsed = new Date();
                }
                
                console.log(`✅ AI Response from ${result.provider} (${result.model})`);
                return result.text;

            } catch (error) {
                lastError = error;
                
                if (this.currentProvider === 'groq') {
                    this.providerStats.groq.failed++;
                    
                    // Check if rate limited
                    if (error.status === 429 || (error.error?.code === 'rate_limit_exceeded')) {
                        console.log(`⚠️ Groq rate limit hit on key #${this.currentGroqIndex + 1}`);
                        this.rotateGroqKey();
                    }
                } else {
                    this.providerStats.google.failed++;
                    
                    // Check if quota exceeded
                    if (error.status === 429 || error.message?.includes('quota')) {
                        console.log(`⚠️ Google AI quota exceeded on key #${this.currentGoogleIndex + 1}`);
                        this.rotateGoogleKey();
                    }
                }
                
                console.error(`❌ ${this.currentProvider.toUpperCase()} Error (attempt ${attempt + 1}):`, error.message);
                
                // Switch provider for next attempt
                await this.switchProvider();
            }
        }

        // If all attempts failed
        const stats = `
📊 *AI Service Stats*:
   Groq: ✅ ${this.providerStats.groq.success} | ❌ ${this.providerStats.groq.failed}
   Google: ✅ ${this.providerStats.google.success} | ❌ ${this.providerStats.google.failed}
        `.trim();
        
        console.error(stats);
        throw new Error(`Semua penyedia AI mengalami error. Error terakhir: ${lastError.message}\n\n${stats}`);
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
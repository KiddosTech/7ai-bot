FROM node:20-slim

# Install dependencies untuk canvas (kalau perlu)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Buat folder database
RUN mkdir -p database

# Expose port (untuk health check)
EXPOSE 3000

# Start bot
CMD ["npm", "start"]
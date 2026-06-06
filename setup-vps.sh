#!/bin/bash
set -e

echo "🔄 Atualizando o sistema..."
apt update && apt upgrade -y

echo "📦 Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "🐳 Instalando Docker e Docker Compose..."
apt install -y ca-certificates curl gnupg lsb-release
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "⚙️ Instalando PM2 globalmente..."
npm install -g pm2

echo "📥 Instalando Git..."
apt install -y git

echo "📂 Clonando repositório em /opt/livelo-alert..."
git clone https://github.com/Brunoacciolydacosta/livelo-alert /opt/livelo-alert

echo "📦 Instalando dependências do projeto..."
cd /opt/livelo-alert && npm install

echo "🐳 Subindo Evolution API via Docker..."
docker run -d \
  --name evolution-api \
  --restart unless-stopped \
  -p 8080:8080 \
  -e AUTHENTICATION_API_KEY=minha-chave-secreta \
  -v evolution_data:/evolution/instances \
  atendai/evolution-api:v1.8.7

echo "✅ Instalação concluída!"

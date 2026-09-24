# 極簡 Node.js 執行環境——這個服務刻意零框架依賴（見 package.json），
# 不需要 npm install，直接複製原始碼進去執行即可。
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "src/server.js"]

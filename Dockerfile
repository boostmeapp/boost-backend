FROM node:18-alpine
WORKDIR /app

# IMPORTANT: ensure devDependencies install (Nest build needs them)
ENV NODE_ENV=development

COPY package*.json ./
RUN npm install

COPY . .

# build + show what's produced
RUN npm run build
RUN echo "===== DIST TREE =====" && ls -R dist || true
RUN echo "===== ROOT TREE =====" && ls -la

# runtime
ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "dist/src/main.js"]

# ---- Stage 1: build the React client ----
FROM node:20-alpine AS client-build
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build


# ---- Stage 2: production runtime (Express + baked-in OCR model) ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production

WORKDIR /app/server

# Server dependencies only.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Server code + built client (served by Express from ../client/dist).
COPY server/index.js ./
COPY --from=client-build /app/client/dist /app/client/dist

# Bake the English OCR model into the image so the first /api/ocr request
# never downloads anything. tesseract.js v6 defaults to LSTM_ONLY, so it
# fetches eng.traineddata.gz from the 4.0.0_best_int set on jsDelivr and
# caches it as ./eng.traineddata relative to the process working directory.
ADD https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz /tmp/eng.traineddata.gz
RUN node --input-type=module -e "import {createReadStream,createWriteStream,statSync} from 'node:fs';import {createGunzip} from 'node:zlib';import {pipeline} from 'node:stream/promises';await pipeline(createReadStream('/tmp/eng.traineddata.gz'),createGunzip(),createWriteStream('/app/server/eng.traineddata'));const s=statSync('/app/server/eng.traineddata');if(s.size<1000000)throw new Error('traineddata looks truncated: '+s.size);console.log('eng.traineddata baked in ('+s.size+' bytes)');" \
  && rm /tmp/eng.traineddata.gz

# Run as a non-root user.
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
  && chown -R appuser:appuser /app
USER appuser

EXPOSE 3001

# Node 20 has a global fetch, so no curl needed for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
